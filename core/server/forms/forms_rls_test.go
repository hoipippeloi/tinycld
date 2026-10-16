package forms

import (
	"net/http"
	"strings"
	"testing"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"
	"tinycld.org/core/rlstest"
)

func body(s string) *strings.Reader { return strings.NewReader(s) }

func setupFormsRLSApp(t *testing.T) *tests.TestApp {
	t.Helper()
	app := rlstest.NewAssembledApp(t)
	return app
}

func formsUser(t *testing.T, app core.App, email, role string) (*core.Record, string) {
	t.Helper()
	users, _ := app.FindCollectionByNameOrId("users")
	u := core.NewRecord(users)
	u.SetEmail(email)
	u.SetPassword("password123")
	u.Set("role", role)
	u.Set("name", email)
	u.Set("username", strings.Split(email, "@")[0])
	if err := app.Save(u); err != nil {
		t.Fatal(err)
	}
	token, err := u.NewAuthToken()
	if err != nil {
		t.Fatal(err)
	}
	return u, token
}

const minimalDefinition = `{"version":1,"pages":[{"key":"main","title":"Main"}],"fields":[]}`

func formBody(host, slug string) string {
	return `{"host":"` + host + `","name":"` + slug + `","slug":"` + slug + `","definition":` + minimalDefinition + `,"is_default":false,"archived":false,"order":1}`
}

func TestFormsRLS_AdminCanCreateMemberCannot(t *testing.T) {
	app := setupFormsRLSApp(t)
	_, adminToken := formsUser(t, app, "admin@test.local", "admin")
	_, memberToken := formsUser(t, app, "member@test.local", "member")
	factory := func(testing.TB) *tests.TestApp { return app }
	for _, sc := range []tests.ApiScenario{
		{Name: "admin creates", Method: http.MethodPost, URL: "/api/collections/forms/records", Body: body(formBody("gizmos:widget", "bug")), Headers: map[string]string{"Authorization": adminToken}, ExpectedStatus: 200, ExpectedContent: []string{`"slug":"bug"`}, TestAppFactory: factory, DisableTestAppCleanup: true},
		{Name: "member cannot create", Method: http.MethodPost, URL: "/api/collections/forms/records", Body: body(formBody("gizmos:widget", "task")), Headers: map[string]string{"Authorization": memberToken}, ExpectedStatus: 400, ExpectedContent: []string{`"Failed to create record."`}, TestAppFactory: factory, DisableTestAppCleanup: true},
		{Name: "anonymous cannot list", Method: http.MethodGet, URL: "/api/collections/forms/records", ExpectedStatus: 200, ExpectedContent: []string{`"totalItems":0`}, NotExpectedContent: []string{`"slug":"bug"`}, TestAppFactory: factory, DisableTestAppCleanup: true},
	} {
		sc.Test(t)
	}
}

func TestFormsRLS_SlugUniquePerHost(t *testing.T) {
	app := setupFormsRLSApp(t)
	_, adminToken := formsUser(t, app, "admin@test.local", "admin")
	factory := func(testing.TB) *tests.TestApp { return app }
	first := tests.ApiScenario{Method: http.MethodPost, URL: "/api/collections/forms/records", Body: body(formBody("gizmos:widget", "bug")), Headers: map[string]string{"Authorization": adminToken}, ExpectedStatus: 200, ExpectedContent: []string{`"slug":"bug"`}, TestAppFactory: factory, DisableTestAppCleanup: true}
	first.Test(t)
	dup := first
	dup.Body = body(formBody("gizmos:widget", "bug"))
	dup.ExpectedStatus = 400
	dup.ExpectedContent = []string{`"slug"`}
	dup.Test(t)
	other := first
	other.Body = body(formBody("gizmos:other", "bug"))
	other.ExpectedStatus = 200
	other.ExpectedContent = []string{`"host":"gizmos:other"`}
	other.Test(t)
}

func TestFormsRLS_MemberCannotUpdateOrDeleteAndAnonymousCannotCreate(t *testing.T) {
	app := setupFormsRLSApp(t)
	_, memberToken := formsUser(t, app, "member@test.local", "member")
	col, err := app.FindCollectionByNameOrId("forms")
	if err != nil {
		t.Fatal(err)
	}
	form := core.NewRecord(col)
	form.Set("host", "gizmos:widget")
	form.Set("name", "bug")
	form.Set("slug", "bug")
	form.Set("definition", []byte(minimalDefinition))
	form.Set("order", 1)
	if err := app.Save(form); err != nil {
		t.Fatal(err)
	}
	url := "/api/collections/forms/records/" + form.Id
	factory := func(testing.TB) *tests.TestApp { return app }
	for _, sc := range []tests.ApiScenario{
		{Name: "member cannot update", Method: http.MethodPatch, URL: url, Body: body(`{"name":"renamed"}`), Headers: map[string]string{"Authorization": memberToken}, ExpectedStatus: 404, ExpectedContent: []string{`"data":{}`}, TestAppFactory: factory, DisableTestAppCleanup: true},
		{Name: "member cannot delete", Method: http.MethodDelete, URL: url, Headers: map[string]string{"Authorization": memberToken}, ExpectedStatus: 404, ExpectedContent: []string{`"data":{}`}, TestAppFactory: factory, DisableTestAppCleanup: true},
		{Name: "anonymous cannot create", Method: http.MethodPost, URL: "/api/collections/forms/records", Body: body(formBody("gizmos:widget", "task")), ExpectedStatus: 400, ExpectedContent: []string{`"Failed to create record."`}, TestAppFactory: factory, DisableTestAppCleanup: true},
	} {
		sc.Test(t)
	}
	stored, err := app.FindRecordById("forms", form.Id)
	if err != nil || stored.GetString("name") != "bug" {
		t.Fatalf("the form must be untouched: %v %v", stored, err)
	}
	if n, _ := app.CountRecords("forms"); n != 1 {
		t.Fatalf("anonymous create must not persist, forms = %d", n)
	}
}
