package reports

import (
	"reflect"
	"testing"

	"github.com/pocketbase/dbx"
)

// ruleIDs runs the rule SELECT as a CTE, as the compiler uses it.
func ruleIDs(t *testing.T, z *zoo, collection, user string) []string {
	t.Helper()
	col, err := z.app.FindCollectionByNameOrId(collection)
	if err != nil {
		t.Fatal(err)
	}
	sql, params, err := ruleSelect(z.app, col, z.as(user))
	if err != nil {
		t.Fatal(err)
	}
	ids := []string{}
	if err := z.app.DB().NewQuery("WITH r AS (" + sql + ") SELECT id FROM r ORDER BY id").Bind(params).Column(&ids); err != nil {
		t.Fatalf("%s: %v", collection, err)
	}
	return ids
}

func TestRuleSelectMatchesTheListAPI(t *testing.T) {
	z := newZoo(t)
	mux := z.mux(t)
	// zoo_animals has a back-relation rule and zoo_feedings an @collection
	// rule: the resolver joins for both, and the joins stay inside the CTE.
	for _, user := range []string{"ann", "bob"} {
		for _, collection := range []string{"users", "zoo_sites", "zoo_animals", "zoo_keepers", "zoo_feedings"} {
			got := ruleIDs(t, z, collection, user)
			want := z.listIDs(t, mux, collection, user, "")
			if !reflect.DeepEqual(got, want) {
				t.Errorf("%s as %s: rule CTE %v, list API %v", collection, user, got, want)
			}
		}
	}
	if got, want := ruleIDs(t, z, "zoo_feedings", "ann"), z.ids("f1", "f2", "f3", "f4"); !reflect.DeepEqual(got, want) {
		t.Errorf("ann's feedings = %v, want %v", got, want)
	}
	if got, want := ruleIDs(t, z, "zoo_animals", "bob"), z.ids("zed", "mo"); !reflect.DeepEqual(got, want) {
		t.Errorf("bob's animals = %v, want %v", got, want)
	}
}

func TestRuleSelectOfANullRuleIsEmpty(t *testing.T) {
	z := newZoo(t)
	if got := ruleIDs(t, z, "zoo_vault", "ann"); len(got) != 0 {
		t.Fatalf("superuser-only collection gave a reader %v", got)
	}
}

func TestTwoRuleCTEsShareOneStatement(t *testing.T) {
	z := newZoo(t)
	feedings, _ := z.app.FindCollectionByNameOrId("zoo_feedings")
	animals, _ := z.app.FindCollectionByNameOrId("zoo_animals")
	fSQL, fParams, err := ruleSelect(z.app, feedings, z.as("bob"))
	if err != nil {
		t.Fatal(err)
	}
	aSQL, aParams, err := ruleSelect(z.app, animals, z.as("bob"))
	if err != nil {
		t.Fatal(err)
	}
	params := dbx.Params{}
	for _, p := range []dbx.Params{fParams, aParams} {
		for k, v := range p {
			params[k] = v
		}
	}
	var names []string
	err = z.app.DB().NewQuery("WITH r_f AS (" + fSQL + "), r_a AS (" + aSQL + `)
		SELECT a.name FROM r_f f JOIN r_a a ON a.id = f.animal ORDER BY f.cost`).Bind(params).Column(&names)
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{"Mo", "Zed", "Zed"}; !reflect.DeepEqual(names, want) {
		t.Fatalf("names = %v, want %v", names, want)
	}
}
