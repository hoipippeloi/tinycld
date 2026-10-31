package reports

import (
	"fmt"
	"strings"

	"github.com/pocketbase/pocketbase/core"
)

// compiler compiles one run of a plan: params resolved, fiscal start known.
type compiler struct {
	p      *plan
	app    core.App // nil when dry (Validate)
	info   *core.RequestInfo
	params map[string]paramValue
	fiscal int
	// currencies names w's currency keys; every total groups by them, so
	// amounts in different currencies are never added together.
	currencies []string
	// currencyOf maps a money column's id to its currency key.
	currencyOf map[string]string
	// detailTypes and levelTypes are each column's type on detail rows
	// and on group, subtotal and total rows.
	detailTypes map[string]FieldType
	levelTypes  map[string]FieldType
}

func newCompiler(p *plan, app core.App, info *core.RequestInfo, params map[string]paramValue) *compiler {
	c := &compiler{p: p, app: app, info: info, params: params, fiscal: 1, currencyOf: map[string]string{}}
	if app != nil {
		c.fiscal = fiscalStartOf(p.base, app)
	}
	if params == nil {
		// Dry: every param unset, which still has its type.
		c.params = map[string]paramValue{}
		for _, d := range p.spec.Params {
			c.params[d.ID] = paramValue{typ: d.Type, multiple: d.Multiple, unset: true}
		}
	}
	return c
}

// fiscalStartOf is the source's fiscal start month, 1 when it has none.
func fiscalStartOf(src *Source, app core.App) int {
	if src.FiscalStartMonth == nil {
		return 1
	}
	if m := src.FiscalStartMonth(app); m >= 1 && m <= 12 {
		return m
	}
	return 1
}

// rowsCTE is the CTE `w`: one row per base row the reader may list that
// passes the filter, with every value a later pass reads: group keys k<n>,
// currency keys ck<n>, the pivot key pk, path columns c<idx>, hidden path
// values h<n>, to-many parent ids p<idx> (and cs/cn for an average), and
// nest parent ids n<level>.
type rowsCTE struct {
	c      *compiler
	s      *stmt
	root   *scope
	raw    map[string]string // name → its expression inside w
	order  []string
	byExpr map[string]string
	filter string
}

func (c *compiler) rows(s *stmt) (*rowsCTE, error) {
	// Each statement builds its own w; the currency keys come out the same.
	c.currencies, c.currencyOf = nil, map[string]string{}
	r := &rowsCTE{c: c, s: s, root: newScope(s, c.p.base), raw: map[string]string{}, byExpr: map[string]string{}}
	r.add("__id", q(r.root.alias, "id"))
	if f := c.p.spec.Filter; f != nil {
		e, err := compileFormula(r.join(true), f, "filter")
		if err != nil {
			return nil, err
		}
		if e.typ != Bool {
			return nil, invalid("filter", "the filter is a condition")
		}
		r.filter = e.sql
	}
	for i, g := range c.p.groups {
		e, err := r.rowValue(g.col, g.at+".col", map[string]bool{})
		if err != nil {
			return nil, err
		}
		if g.group.Bucket != "" {
			if e.typ != Date && e.typ != DateTime {
				return nil, invalid(g.at+".bucket", "only a date column has a bucket")
			}
			e.sql = bucketSQL(r.join(false), g.group.Bucket, e.sql)
		}
		r.add(fmt.Sprintf("k%d", i), e.sql)
	}
	for _, cp := range c.p.cols {
		if cp.path == nil || cp.nest > 0 {
			continue
		}
		r.colValue(cp)
		if cp.tm < 0 && cp.path.field.Currency != "" {
			cur := cp.path.src.field(cp.path.field.Currency)
			sql := fieldSQL(r.root.join(cp.path.hops), cur)
			name, seen := r.byExpr[sql]
			if !seen {
				name = fmt.Sprintf("ck%d", len(c.currencies))
				r.byExpr[sql] = name
				r.add(name, sql)
				c.currencies = append(c.currencies, name)
			}
			c.currencyOf[cp.col.ID] = name
		}
	}
	r.pivotKey()
	return r, nil
}

// add puts a value in w under name, once, and returns its reference.
func (r *rowsCTE) add(name, sql string) string {
	if _, ok := r.raw[name]; !ok {
		r.raw[name] = sql
		r.order = append(r.order, name)
	}
	return "w." + name
}

// colValue puts a path column's value in w and returns its reference. A
// to-many total reads its subquery; a parent with no visible linked rows
// counts and sums to 0.
func (r *rowsCTE) colValue(cp *colPlan) expr {
	idx := r.c.p.index(cp)
	name := fmt.Sprintf("c%d", idx)
	typ := cp.path.field.Type
	if cp.tm >= 0 {
		typ = aggregateType(cp.col.Aggregate, typ, cp.scale)
	}
	if _, ok := r.raw[name]; ok {
		return expr{sql: "w." + name, typ: typ}
	}
	if cp.tm < 0 {
		r.add(name, r.root.value(cp.path).sql)
		return expr{sql: "w." + name, typ: typ}
	}
	op := cp.col.Aggregate
	value := r.root.total(cp.path, cp.tm, op, cp.scale)
	if op == Count || op == Sum {
		value = "COALESCE(" + value + ", 0)"
	}
	r.add(name, value)
	r.add(fmt.Sprintf("p%d", idx), r.root.parentID(cp.path, cp.tm))
	if op == Avg {
		r.add(fmt.Sprintf("cs%d", idx), r.root.total(cp.path, cp.tm, Sum, 0))
		r.add(fmt.Sprintf("cn%d", idx), r.root.total(cp.path, cp.tm, Count, 0))
	}
	return expr{sql: "w." + name, typ: typ}
}

// inner is the expression behind a reference to w, for use inside w's own
// select (its WHERE and its group keys).
func (r *rowsCTE) inner(ref string) string {
	if sql, ok := r.raw[strings.TrimPrefix(ref, "w.")]; ok {
		return sql
	}
	return ref
}

// hidden is a value path a formula reads, kept in w.
func (r *rowsCTE) hidden(p *pathPlan) string {
	key := "path:" + hopsKey(p.hops) + "." + p.field.Key
	if name, ok := r.byExpr[key]; ok {
		return "w." + name
	}
	name := fmt.Sprintf("h%d", len(r.order))
	r.byExpr[key] = name
	return r.add(name, r.root.value(p).sql)
}

// rowValue is a column's value per base row, as an expression inside w: a
// group key, the pivot key, or a column a filter compares.
func (r *rowsCTE) rowValue(cp *colPlan, at string, visiting map[string]bool) (expr, error) {
	if cp.nest > 0 {
		return expr{}, invalid(at, "a child row column is not a value of the report's rows")
	}
	if cp.path != nil {
		e := r.colValue(cp)
		e.sql = r.inner(e.sql)
		return e, nil
	}
	j := r.join(false)
	j.visiting = visiting
	return compileFormula(j, cp.col.Formula, cp.at+".formula")
}

func (r *rowsCTE) join(filter bool) *joinCtx {
	return &joinCtx{r: r, sc: r.root, src: r.c.p.base, isFilter: filter, visiting: map[string]bool{}}
}

func (r *rowsCTE) render() string {
	cols := make([]string, len(r.order))
	for i, name := range r.order {
		cols[i] = r.raw[name] + " AS " + name
	}
	sql := "w AS (SELECT " + strings.Join(cols, ", ") + "\n" + r.root.render()
	if r.filter != "" {
		sql += "\nWHERE " + r.filter
	}
	return sql + ")"
}

// bucketSQL buckets a date: day, month (2026-01), quarter (2026-Q1), year,
// or the base source's fiscal year.
func bucketSQL(c fctx, bucket, day string) string {
	switch bucket {
	case "day":
		return "substr(" + day + ", 1, 10)"
	case "month":
		return "substr(" + day + ", 1, 7)"
	case "quarter":
		return "(substr(" + day + ", 1, 4) || '-Q' || ((CAST(substr(" + day + ", 6, 2) AS INTEGER) + 2) / 3))"
	case "year":
		return "substr(" + day + ", 1, 4)"
	}
	return "tc_fiscal_year(" + day + ", " + c.fiscalStart() + ")"
}

func (p *plan) index(cp *colPlan) int {
	for i, x := range p.cols {
		if x == cp {
			return i
		}
	}
	return -1
}
