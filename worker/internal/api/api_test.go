package api_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"sort"
	"strings"
	"testing"

	"github.com/getkin/kin-openapi/openapi3"

	"github.com/agentfund/agentfund/worker/internal/api"
	"github.com/agentfund/agentfund/worker/internal/apitest"
)

var ctx = context.Background()

func p[T any](v T) *T { return &v }

// flatten merges allOf members into one property/required view.
func flatten(s *openapi3.Schema) (props map[string]*openapi3.Schema, required map[string]bool) {
	props, required = map[string]*openapi3.Schema{}, map[string]bool{}
	var walk func(s *openapi3.Schema)
	walk = func(s *openapi3.Schema) {
		for _, sub := range s.AllOf {
			walk(sub.Value)
		}
		for name, ref := range s.Properties {
			props[name] = ref.Value
		}
		for _, r := range s.Required {
			required[r] = true
		}
	}
	walk(s)
	return
}

func schemaAllows(s *openapi3.Schema, typ string) bool {
	if s.Type == nil || len(*s.Type) == 0 {
		if len(s.OneOf) > 0 || len(s.AllOf) > 0 || len(s.AnyOf) > 0 {
			return typ == "object" || typ == "null"
		}
		return true
	}
	return s.Type.Includes(typ)
}

// checkStruct verifies a Go wire struct against a schema:
//   - every JSON field of the struct is a documented property of a compatible type;
//   - for request bodies, every required property is always sent;
//   - for responses, every field the worker reads without a pointer/omitempty
//     is required by the schema (so the zero value never hides a missing field)
//     unless listed in optionalOK.
func checkStruct(t *testing.T, name string, typ reflect.Type, s *openapi3.Schema, request bool, optionalOK ...string) {
	t.Helper()
	props, required := flatten(s)
	seen := map[string]bool{}
	for i := 0; i < typ.NumField(); i++ {
		f := typ.Field(i)
		tag := f.Tag.Get("json")
		jsonName, opts, _ := strings.Cut(tag, ",")
		if jsonName == "" || jsonName == "-" {
			t.Errorf("%s.%s has no json name", name, f.Name)
			continue
		}
		seen[jsonName] = true
		ps, ok := props[jsonName]
		if !ok {
			t.Errorf("%s.%s: property %q is not in the OpenAPI schema", name, f.Name, jsonName)
			continue
		}
		ft := f.Type
		pointer := ft.Kind() == reflect.Pointer
		if pointer {
			ft = ft.Elem()
		}
		var want string
		switch ft.Kind() {
		case reflect.String:
			want = "string"
		case reflect.Bool:
			want = "boolean"
		case reflect.Int, reflect.Int64:
			want = "integer"
		case reflect.Float64:
			want = "number"
		case reflect.Slice:
			want = "array"
			if ft.Elem().Kind() == reflect.Uint8 { // json.RawMessage
				want = "object"
			}
		case reflect.Struct:
			want = "object"
			if ft.String() == "time.Time" {
				want = "string"
			}
		default:
			t.Errorf("%s.%s: unsupported kind %s", name, f.Name, ft.Kind())
			continue
		}
		if !schemaAllows(ps, want) && !(want == "integer" && schemaAllows(ps, "number")) {
			t.Errorf("%s.%s: Go type %s does not fit schema type %v of %q", name, f.Name, f.Type, ps.Type, jsonName)
		}
		omit := strings.Contains(opts, "omitempty") || strings.Contains(opts, "omitzero")
		if request && required[jsonName] && omit {
			t.Errorf("%s.%s: %q is required by the schema but may be omitted", name, f.Name, jsonName)
		}
		if !request && !pointer && !omit && !required[jsonName] && !contains(optionalOK, jsonName) {
			t.Errorf("%s.%s: %q is optional in the schema; read it through a pointer or omitempty", name, f.Name, jsonName)
		}
		if !request && !pointer && schemaAllows(ps, "null") && ps.Type != nil && want != "array" {
			t.Errorf("%s.%s: %q is nullable in the schema; use a pointer", name, f.Name, jsonName)
		}
	}
	if request {
		for r := range required {
			if !seen[r] {
				t.Errorf("%s: required property %q is never sent", name, r)
			}
		}
	}
}

func contains(l []string, s string) bool {
	for _, x := range l {
		if x == s {
			return true
		}
	}
	return false
}

func requestSchema(t *testing.T, doc *openapi3.T, path string) *openapi3.Schema {
	t.Helper()
	item := doc.Paths.Find(path)
	if item == nil || item.Post == nil || item.Post.RequestBody == nil {
		t.Fatalf("no POST request body for %s", path)
	}
	return item.Post.RequestBody.Value.Content.Get("application/json").Schema.Value
}

func TestStructsMatchOpenAPI(t *testing.T) {
	doc := apitest.LoadSpec(t)
	sc := func(n string) *openapi3.Schema { return apitest.Schema(t, doc, n) }

	// Responses the worker decodes.
	checkStruct(t, "Meta", reflect.TypeOf(api.Meta{}), sc("Meta"), false)
	checkStruct(t, "MetaLinks", reflect.TypeOf(api.MetaLinks{}), sc("Meta").Properties["links"].Value, false)
	checkStruct(t, "Me", reflect.TypeOf(api.Me{}), sc("Me"), false)
	checkStruct(t, "UserRef", reflect.TypeOf(api.UserRef{}), sc("UserRef"), false)
	checkStruct(t, "Project", reflect.TypeOf(api.Project{}), sc("Project"), false)
	checkStruct(t, "ProjectTrust", reflect.TypeOf(api.ProjectTrust{}), sc("ProjectTrust"), false)
	checkStruct(t, "Task", reflect.TypeOf(api.Task{}), sc("Task"), false)
	checkStruct(t, "Manifest", reflect.TypeOf(api.Manifest{}), sc("Manifest"), false)
	checkStruct(t, "Claim", reflect.TypeOf(api.Claim{}), sc("Claim"), false)
	checkStruct(t, "ClaimSummary", reflect.TypeOf(api.ClaimSummary{}), sc("ClaimSummary"), false)
	checkStruct(t, "Report", reflect.TypeOf(api.Report{}), sc("Report"), false)
	checkStruct(t, "Problem", reflect.TypeOf(api.Problem{}), sc("Problem"), false)

	// Request bodies the worker sends.
	checkStruct(t, "ReportCreate", reflect.TypeOf(api.ReportCreate{}), sc("ReportCreate"), true)
	checkStruct(t, "HeartbeatRequest", reflect.TypeOf(api.HeartbeatRequest{}), requestSchema(t, doc, "/v1/claims/{claim_id}/heartbeat"), true)
	checkStruct(t, "ReleaseRequest", reflect.TypeOf(api.ReleaseRequest{}), requestSchema(t, doc, "/v1/claims/{claim_id}/release"), true)

	// Enumerations.
	enum := func(s *openapi3.Schema) []string {
		var out []string
		for _, v := range s.Enum {
			out = append(out, v.(string))
		}
		sort.Strings(out)
		return out
	}
	wantStatuses := []string{api.StatusBudgetExceeded, api.StatusCompleted, api.StatusFailed, api.StatusTimeout, api.StatusVerificationFailed}
	if got := enum(sc("ReportStatus")); !reflect.DeepEqual(got, wantStatuses) {
		t.Errorf("ReportStatus enum is %v, client knows %v", got, wantStatuses)
	}
	hb := requestSchema(t, doc, "/v1/claims/{claim_id}/heartbeat")
	wantPhases := []string{api.PhaseAgent, api.PhasePushing, api.PhaseSandbox, api.PhaseVerify, api.PhaseVerifying}
	if got := enum(hb.Properties["phase"].Value); !reflect.DeepEqual(got, wantPhases) {
		t.Errorf("heartbeat phase enum is %v, client knows %v", got, wantPhases)
	}
}

func TestRequestBodiesValidate(t *testing.T) {
	doc := apitest.LoadSpec(t)
	valid := func(name string, s *openapi3.Schema, v any) {
		t.Helper()
		raw, _ := json.Marshal(v)
		if err := apitest.ValidateJSON(s, raw); err != nil {
			t.Errorf("%s: %s violates the schema: %v", name, raw, err)
		}
	}
	rc := apitest.Schema(t, doc, "ReportCreate")
	valid("completed report", rc, api.ReportCreate{
		Status: api.StatusCompleted, TokensIn: 10, TokensOut: 5, CostEstimate: 0.12,
		Branch: p("agentfund/0001-slugify-00000000"), PRURL: p("https://github.com/a/b/pull/1"), HeadSHA: p(strings.Repeat("a", 40)),
		VerifyExitCode: p(0), LogDigest: strings.Repeat("b", 64), DurationSeconds: p(int64(12)), Runner: "claude-code/2.1.289", Model: "m",
	})
	for _, st := range []string{api.StatusFailed, api.StatusVerificationFailed, api.StatusBudgetExceeded, api.StatusTimeout} {
		valid(st+" report (minimal)", rc, api.ReportCreate{Status: st, LogDigest: strings.Repeat("0", 64)})
		valid(st+" report (with message)", rc, api.ReportCreate{Status: st, LogDigest: strings.Repeat("0", 64), VerifyExitCode: p(1), Message: "why"})
	}
	hb := requestSchema(t, doc, "/v1/claims/{claim_id}/heartbeat")
	valid("empty heartbeat", hb, api.HeartbeatRequest{})
	for _, ph := range []string{api.PhaseVerifying, api.PhaseSandbox, api.PhaseAgent, api.PhaseVerify, api.PhasePushing} {
		valid("heartbeat "+ph, hb, api.HeartbeatRequest{TokensIn: p(int64(1)), TokensOut: p(int64(0)), Phase: ph})
	}
	rel := requestSchema(t, doc, "/v1/claims/{claim_id}/release")
	valid("empty release", rel, api.ReleaseRequest{})
	valid("release with burn", rel, api.ReleaseRequest{Reason: "rate limited", TokensIn: p(int64(5)), TokensOut: p(int64(6))})
}

// TestClientAgainstSpecValidatedFake drives every client method against the
// fake, which validates all bodies against openapi.yaml.
func TestClientAgainstSpecValidatedFake(t *testing.T) {
	srv := apitest.New(t)
	srv.RepoURL, srv.Commit = "https://github.com/example/hello", strings.Repeat("a", 40)
	srv.Pubkey, srv.Fingerprint = "RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3", "SHA256:"+strings.Repeat("c", 64)
	cap := int64(5_000_000)
	srv.TrustTier, srv.TrustTaskCap = "new", &cap
	srv.Tasks = []apitest.TaskSpec{
		{ManifestID: "0001-slugify", Title: "t", ContentHash: strings.Repeat("d", 64), MaxTokens: 1000, Prompt: "p", Verify: "true", Write: []string{"a"}, Claimable: true},
		{ManifestID: "0002-truncate", Title: "t", ContentHash: strings.Repeat("e", 64), MaxTokens: 1000, Prompt: "p", Verify: "true", Write: []string{"a"}, DependsOn: []string{"0001-slugify"}},
	}
	c := api.New(srv.URL+"/", srv.APIKey)

	meta, err := c.Negotiate(ctx, 1)
	if err != nil || meta.Defaults == nil || meta.Defaults.HeartbeatIntervalSeconds != 1 {
		t.Fatalf("negotiate: %+v %v", meta, err)
	}
	if _, err := c.Negotiate(ctx, 2); err == nil {
		t.Fatal("negotiated an unsupported spec version")
	}
	me, err := c.Me(ctx)
	if err != nil || me.Handle != "donor" {
		t.Fatalf("me: %+v %v", me, err)
	}
	if _, err := api.New(srv.URL, "af_wrong").Me(ctx); !api.IsCode(err, api.CodeUnauthorized) {
		t.Fatalf("bad key: %v", err)
	}
	proj, err := c.Project(ctx, "hello-project")
	if err != nil || proj.Trust.Tier != "new" || proj.Trust.MaxTokensPerTask == nil || *proj.Trust.MaxTokensPerTask != cap || proj.Trust.MaxTokensPerDay != nil {
		t.Fatalf("project: %+v %v", proj, err)
	}
	if _, err := c.Project(ctx, "nope"); !api.IsCode(err, api.CodeNotFound) {
		t.Fatalf("missing project: %v", err)
	}
	all, err := c.Tasks(ctx, "hello-project", false)
	if err != nil || len(all) != 2 {
		t.Fatalf("tasks: %v %v", all, err)
	}
	one, err := c.Task(ctx, "hello-project:0002-truncate")
	if err != nil || one.TaskID != "0002-truncate" || one.Claimable || one.Manifest.Prompt != "p" {
		t.Fatalf("get task: %+v %v", one, err)
	}
	if _, err := c.Task(ctx, "hello-project:0009-nope"); !api.IsCode(err, api.CodeNotFound) {
		t.Fatalf("missing task: %v", err)
	}
	claimable, _ := c.Tasks(ctx, "hello-project", true)
	if len(claimable) != 1 || claimable[0].ID != "hello-project:0001-slugify" || claimable[0].Manifest.MaxTokens != 1000 {
		t.Fatalf("claimable: %+v", claimable)
	}
	if _, err := c.Claim(ctx, "hello-project:0002-truncate"); !api.IsCode(err, api.CodeTaskNotOpen) {
		t.Fatalf("claim of blocked task: %v", err)
	}
	cl, err := c.Claim(ctx, "hello-project:0001-slugify")
	if err != nil || cl.Commit != srv.Commit || cl.HeartbeatIntervalSeconds != 1 || cl.Task.TaskID != "0001-slugify" {
		t.Fatalf("claim: %+v %v", cl, err)
	}
	if _, err := c.Claim(ctx, "hello-project:0001-slugify"); !api.IsCode(err, api.CodeTaskNotOpen) {
		t.Fatalf("double claim: %v", err)
	}
	if _, err := c.Heartbeat(ctx, cl.ClaimID, api.HeartbeatRequest{TokensIn: p(int64(3)), TokensOut: p(int64(4)), Phase: api.PhaseAgent}); err != nil {
		t.Fatalf("heartbeat: %v", err)
	}
	active, err := c.MyClaims(ctx, true)
	if err != nil || len(active) != 1 || active[0].Status != "active" {
		t.Fatalf("my claims: %+v %v", active, err)
	}
	rep, err := c.Report(ctx, cl.ClaimID, api.ReportCreate{Status: api.StatusFailed, TokensIn: 3, TokensOut: 4, LogDigest: strings.Repeat("0", 64), VerifyExitCode: p(1), Message: "verify failed"})
	if err != nil || rep.Status != api.StatusFailed || rep.Delivery != "none" {
		t.Fatalf("report: %+v %v", rep, err)
	}
	if _, err := c.Report(ctx, cl.ClaimID, api.ReportCreate{Status: api.StatusFailed, LogDigest: strings.Repeat("0", 64)}); !api.IsCode(err, api.CodeAlreadyReported) {
		t.Fatalf("second report: %v", err)
	}
	if _, err := c.Heartbeat(ctx, cl.ClaimID, api.HeartbeatRequest{}); !api.IsCode(err, api.CodeClaimNotActive) {
		t.Fatalf("heartbeat after report: %v", err)
	}
	cl2, err := c.Claim(ctx, "hello-project:0001-slugify")
	if err != nil {
		t.Fatalf("re-claim after failed report: %v", err)
	}
	if err := c.Release(ctx, cl2.ClaimID, api.ReleaseRequest{Reason: "policy", TokensIn: p(int64(1)), TokensOut: p(int64(2))}); err != nil {
		t.Fatalf("release: %v", err)
	}
	if err := c.Release(ctx, cl2.ClaimID, api.ReleaseRequest{}); !api.IsCode(err, api.CodeClaimNotActive) {
		t.Fatalf("double release: %v", err)
	}
	for _, call := range srv.Calls("/v1/") {
		if strings.Contains(call.Path, "/claim") || strings.Contains(call.Path, "/me") {
			if !strings.HasPrefix(call.Auth, "Bearer af_") {
				t.Errorf("%s %s sent without a bearer key", call.Method, call.Path)
			}
		}
	}
}

func TestProblemDecoding(t *testing.T) {
	cases := []struct {
		name, ctype, body string
		status            int
		wantCode          string
		header            http.Header
	}{
		{"problem+json", "application/problem+json", `{"type":"https://x.example/problems/claim-not-active","title":"Gone","status":409,"detail":"lease expired"}`, 409, "claim-not-active", nil},
		{"with charset", "application/problem+json; charset=utf-8", `{"type":"https://x.example/problems/rate-limited","title":"Slow down","status":429}`, 429, "rate-limited", http.Header{"Retry-After": {"7"}}},
		{"relative type", "application/problem+json", `{"type":"/problems/task-not-open","title":"t","status":409}`, 409, "task-not-open", nil},
		{"trailing slash and fragment", "application/problem+json", `{"type":"https://x/problems/validation/#x","title":"t","status":422,"errors":[{"path":"/a","message":"bad"}]}`, 422, "validation", nil},
		{"html error page", "text/html", `<html>502 Bad Gateway</html>`, 502, "", nil},
		{"json but not a problem", "application/json", `{"error":"nope"}`, 500, "", nil},
		{"empty body", "", ``, 503, "", nil},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				for k, v := range c.header {
					w.Header()[k] = v
				}
				if c.ctype != "" {
					w.Header().Set("Content-Type", c.ctype)
				}
				w.WriteHeader(c.status)
				_, _ = w.Write([]byte(c.body))
			}))
			defer srv.Close()
			_, err := api.New(srv.URL, "af_x").Me(ctx)
			var ae *api.Error
			if !asError(err, &ae) {
				t.Fatalf("want *api.Error, got %v", err)
			}
			if ae.Code != c.wantCode || ae.HTTPStatus != c.status || api.CodeOf(err) != c.wantCode {
				t.Fatalf("code %q status %d, want %q %d", ae.Code, ae.HTTPStatus, c.wantCode, c.status)
			}
			if c.name == "with charset" && ae.RetryAfter.Seconds() != 7 {
				t.Fatalf("Retry-After not decoded: %s", ae.RetryAfter)
			}
			if err.Error() == "" || strings.Contains(err.Error(), "af_x") {
				t.Fatalf("bad error text %q", err.Error())
			}
		})
	}
}

func asError(err error, target **api.Error) bool {
	e, ok := err.(*api.Error)
	if ok {
		*target = e
	}
	return ok
}
