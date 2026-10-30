package htmldiff

type opKind int

const (
	opEqual opKind = iota
	opInsert
	opDelete
	opChanged // a removed and an added block shown as one, with word marks
)

type blockOp struct {
	kind opKind
	from *block
	to   *block
}

// lcsPairs returns the index pairs of a longest common subsequence of a
// and b, in order.
func lcsPairs(a, b []string) [][2]int {
	n, m := len(a), len(b)
	table := make([][]int, n+1)
	for i := range table {
		table[i] = make([]int, m+1)
	}
	for i := n - 1; i >= 0; i-- {
		for j := m - 1; j >= 0; j-- {
			if a[i] == b[j] {
				table[i][j] = table[i+1][j+1] + 1
			} else {
				table[i][j] = max(table[i+1][j], table[i][j+1])
			}
		}
	}
	var pairs [][2]int
	for i, j := 0, 0; i < n && j < m; {
		switch {
		case a[i] == b[j]:
			pairs = append(pairs, [2]int{i, j})
			i++
			j++
		case table[i+1][j] >= table[i][j+1]:
			i++
		default:
			j++
		}
	}
	return pairs
}

// diffBlocks walks both block lists in `to` order. In each gap between
// matched blocks, a removed block and an added block at the same position
// with enough words in common become one changed block.
func diffBlocks(from, to []block) []blockOp {
	pairs := lcsPairs(keys(from), keys(to))
	var ops []blockOp
	i, j := 0, 0
	for _, p := range append(pairs, [2]int{len(from), len(to)}) {
		ops = append(ops, gapOps(from[i:p[0]], to[j:p[1]])...)
		if p[0] < len(from) && p[1] < len(to) {
			ops = append(ops, blockOp{kind: opEqual, from: &from[p[0]], to: &to[p[1]]})
		}
		i, j = p[0]+1, p[1]+1
	}
	return ops
}

func gapOps(dels, ins []block) []blockOp {
	var ops []blockOp
	k := 0
	for ; k < len(dels) && k < len(ins); k++ {
		if similarity(dels[k].key, ins[k].key) < similarEnough {
			break
		}
		ops = append(ops, blockOp{kind: opChanged, from: &dels[k], to: &ins[k]})
	}
	for d := k; d < len(dels); d++ {
		ops = append(ops, blockOp{kind: opDelete, from: &dels[d]})
	}
	for n := k; n < len(ins); n++ {
		ops = append(ops, blockOp{kind: opInsert, to: &ins[n]})
	}
	return ops
}

func keys(blocks []block) []string {
	out := make([]string, len(blocks))
	for i, b := range blocks {
		out[i] = b.key
	}
	return out
}

func similarity(a, b string) float64 {
	wa, wb := splitWords(a), splitWords(b)
	if len(wa)+len(wb) == 0 {
		return 1
	}
	return 2 * float64(len(lcsPairs(wa, wb))) / float64(len(wa)+len(wb))
}
