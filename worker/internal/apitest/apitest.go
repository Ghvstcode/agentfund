// Package apitest is an in-memory fake of the v1 wire protocol for tests.
// Every request body it receives and every response it sends is validated
// against spec/openapi.yaml, so neither the client nor this fake can drift
// from the contract unnoticed. It is imported only from _test files.
package apitest

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/getkin/kin-openapi/openapi3"

	"github.com/agentfund/agentfund/worker/internal/testutil"
)

// LoadSpec loads spec/openapi.yaml.
func LoadSpec(t testing.TB) *openapi3.T {
	t.Helper()
	loader := openapi3.NewLoader()
	doc, err := loader.LoadFromFile(filepath.Join(testutil.Root(t), "spec", "openapi.yaml"))
	if err != nil {
		t.Fatalf("load openapi.yaml: %v", err)
	}
	return doc
}

// Schema returns a component schema by name.
func Schema(t testing.TB, doc *openapi3.T, name string) *openapi3.Schema {
	t.Helper()
	ref, ok := doc.Components.Schemas[name]
	if !ok || ref.Value == nil {
		t.Fatalf("openapi.yaml has no schema %q", name)
	}
	return ref.Value
}

// ValidateJSON checks raw JSON against a schema.
func ValidateJSON(s *openapi3.Schema, raw []byte) error {
	var v any
	if err := json.Unmarshal(raw, &v); err != nil {
		return fmt.Errorf("not JSON: %w", err)
	}
	return s.VisitJSON(v, openapi3.MultiErrors())
}

// TaskSpec seeds one task.
type TaskSpec struct {
	ManifestID  string
	Title       string
	ContentHash string
	MaxTokens   int64
	Prompt      string
	Verify      string
	Write       []string
	Read        []string
	DependsOn   []string
	Claimable   bool
}

// Call records one request the fake received.
type Call struct {
	Method string
	Path   string
	Auth   string
	Body   map[string]any
}

// Server is the fake instance.
type Server struct {
	T   testing.TB
	URL string

	doc *openapi3.T
	srv *httptest.Server

	mu sync.Mutex
	// Mutable fixtures; lock with Lock/Unlock when changing after start.
	APIKey           string
	Slug             string
	RepoURL          string
	Pubkey           string
	Fingerprint      string
	Commit           string
	LockSHA256       string
	TrustTier        string
	TrustTaskCap     *int64
	TrustDayCap      *int64
	ProtocolVersions []string
	SpecVersions     []int
	HeartbeatSeconds int
	Tasks            []TaskSpec
	// ClaimCommit, when set, is the commit claims name instead of Commit (a pin that moved between listing and claim).
	ClaimCommit string
	// ClaimProblem, when set, makes every claim fail with this 409 problem code.
	ClaimProblem string
	// HeartbeatProblemAfter makes heartbeats fail with claim-not-active after N successes (0 = never).
	HeartbeatProblemAfter int
	// TasksRateLimited makes the next N task listings answer 429 with Retry-After: RetryAfterSeconds.
	TasksRateLimited  int
	RetryAfterSeconds int
	// ReportFailures makes the next N report/release requests fail with 503.
	ReportFailures int
	// ReportProblem, when set, makes every report fail with this 422 problem code.
	ReportProblem string
	// RejectLateReports makes reports for expired claims fail with 409 instead of being stored flagged_late.
	RejectLateReports bool
	// Federation is capabilities.federation; when false the federation endpoints answer 404.
	Federation bool
	// AcceptIdentitiesFrom lists the base URLs of peers whose identity assertions this instance accepts.
	AcceptIdentitiesFrom []string
	// FederatedAccount makes the APIKey account a federated one, which cannot mint assertions (403 forbidden).
	FederatedAccount bool

	fedUsers   map[string]fedUser // federated API key -> user
	assertions int
	seenJTI    map[string]bool
	calls      []Call
	claims     map[string]*claimState
	nextClaim  int
	heartbeats int
}

type fedUser struct{ id, handle string }

// assertionSig is the fake's stand-in for a minisign signature over payload.
func assertionSig(payload string) string {
	sum := sha256.Sum256([]byte(payload))
	return "untrusted comment: fixture signature\n" + hex.EncodeToString(sum[:])
}

type claimState struct {
	task     TaskSpec
	status   string // active, reported, released, expired
	late     bool
	report   map[string]any
	release  map[string]any
	beats    []map[string]any
	claimed  time.Time
	fullTask string
}

// New starts a fake instance.
func New(t testing.TB) *Server {
	t.Helper()
	s := &Server{
		T: t, doc: LoadSpec(t), APIKey: "af_test_key_0123456789", Slug: "hello-project",
		TrustTier: "established", ProtocolVersions: []string{"v1"}, SpecVersions: []int{1},
		HeartbeatSeconds: 1, claims: map[string]*claimState{},
		Federation: true, fedUsers: map[string]fedUser{}, seenJTI: map[string]bool{},
	}
	s.srv = httptest.NewServer(http.HandlerFunc(s.serve))
	s.URL = s.srv.URL
	t.Cleanup(s.srv.Close)
	return s
}

// Lock/Unlock guard fixture changes made while the server is in use.
func (s *Server) Lock()   { s.mu.Lock() }
func (s *Server) Unlock() { s.mu.Unlock() }

// Calls returns the requests seen so far, optionally filtered by a path substring.
func (s *Server) Calls(contains string) []Call {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []Call
	for _, c := range s.calls {
		if strings.Contains(c.Path, contains) {
			out = append(out, c)
		}
	}
	return out
}

// Outcome describes what happened to a claim.
type Outcome struct {
	ClaimID    string
	Task       string
	Status     string // active, reported, released
	Report     map[string]any
	Release    map[string]any
	Heartbeats []map[string]any
	// FlaggedLate is true when the report arrived after the claim expired.
	FlaggedLate bool
}

// Outcomes lists every claim granted, in order.
func (s *Server) Outcomes() []Outcome {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]Outcome, 0, len(s.claims))
	for i := 1; i <= s.nextClaim; i++ {
		id := claimID(i)
		c := s.claims[id]
		out = append(out, Outcome{ClaimID: id, Task: c.task.ManifestID, Status: c.status, Report: c.report, Release: c.release, Heartbeats: c.beats, FlaggedLate: c.late})
	}
	return out
}

func claimID(n int) string { return fmt.Sprintf("clm_%016d", n) }

var (
	reProject = regexp.MustCompile(`^/v1/projects/([a-z0-9-]+)$`)
	reTasks   = regexp.MustCompile(`^/v1/projects/([a-z0-9-]+)/tasks$`)
	reTask    = regexp.MustCompile(`^/v1/tasks/([a-z0-9-]+):([0-9a-z-]+)$`)
	reClaim   = regexp.MustCompile(`^/v1/tasks/([a-z0-9-]+:[0-9a-z-]+)/claim$`)
	reClaimOp = regexp.MustCompile(`^/v1/claims/(clm_[a-z0-9]+)/(heartbeat|report|release)$`)
)

func (s *Server) serve(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	raw, _ := io.ReadAll(r.Body)
	var body map[string]any
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &body); err != nil {
			s.problem(w, 422, "validation", "body is not JSON")
			return
		}
	}
	s.calls = append(s.calls, Call{Method: r.Method, Path: r.URL.Path, Auth: r.Header.Get("Authorization"), Body: body})

	user := fedUser{id: s.URL + "/u/donor", handle: "donor"}
	authed := r.Header.Get("Authorization") == "Bearer "+s.APIKey
	if fu, ok := s.fedUsers[strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")]; ok {
		user, authed = fu, true
	}
	switch {
	case r.Method == "GET" && r.URL.Path == "/v1/meta":
		s.reply(w, r, "/v1/meta", 200, map[string]any{
			"app": "AgentFund", "name": "test instance", "version": "0.0.0-test", "base_url": s.URL,
			"protocol_versions": s.ProtocolVersions, "spec_versions": s.SpecVersions,
			"capabilities": map[string]any{"github_oauth": false, "dev_login": true, "sse": true, "ci_providers": []string{"github", "generic"}, "ci_poll": false, "federation": s.Federation},
			"defaults":     map[string]any{"lease_seconds": 7200, "heartbeat_interval_seconds": s.HeartbeatSeconds},
		})
	case r.Method == "GET" && r.URL.Path == "/v1/me":
		if !authed {
			s.problem(w, 401, "unauthorized", "missing or invalid API key")
			return
		}
		s.reply(w, r, "/v1/me", 200, map[string]any{"id": user.id, "handle": user.handle, "role": "donor", "created_at": now()})
	case r.Method == "POST" && r.URL.Path == "/v1/federation/assertions":
		const tmpl = "/v1/federation/assertions"
		switch {
		case !s.Federation:
			s.problem(w, 404, "not-found", "federation is disabled on this instance")
			return
		case !authed:
			s.problem(w, 401, "unauthorized", "missing or invalid API key")
			return
		case s.FederatedAccount || user.id != s.URL+"/u/donor":
			s.problem(w, 403, "forbidden", "only users whose home is this instance can mint assertions")
			return
		}
		if err := s.validateRequest(tmpl, raw); err != nil {
			s.T.Errorf("worker sent an assertion request that violates openapi.yaml: %v\n%s", err, raw)
			s.problem(w, 422, "validation", err.Error())
			return
		}
		s.assertions++
		exp := time.Now().Add(5 * time.Minute).UTC().Format(time.RFC3339)
		payload, _ := json.Marshal(map[string]any{
			"iss": s.URL, "aud": body["audience"], "sub": user.id, "handle": user.handle,
			"exp": exp, "jti": fmt.Sprintf("%s#%d", s.URL, s.assertions),
		})
		s.reply(w, r, tmpl, 201, map[string]any{
			"assertion": map[string]any{"payload": string(payload), "signature": assertionSig(string(payload))}, "expires_at": exp,
		})
	case r.Method == "POST" && r.URL.Path == "/v1/auth/federated":
		const tmpl = "/v1/auth/federated"
		if !s.Federation {
			s.problem(w, 404, "not-found", "federation is disabled on this instance")
			return
		}
		if err := s.validateRequest(tmpl, raw); err != nil {
			s.T.Errorf("worker sent a federated auth request that violates openapi.yaml: %v\n%s", err, raw)
			s.problem(w, 422, "validation", err.Error())
			return
		}
		doc, _ := body["assertion"].(map[string]any)
		payload, _ := doc["payload"].(string)
		var a struct{ Iss, Aud, Sub, Handle, Exp, Jti string }
		iss, _ := url.Parse("")
		if json.Unmarshal([]byte(payload), &a) == nil {
			iss, _ = url.Parse(a.Iss)
		}
		exp, _ := time.Parse(time.RFC3339, a.Exp)
		trusted := false
		for _, peer := range s.AcceptIdentitiesFrom {
			trusted = trusted || (a.Iss != "" && strings.TrimRight(peer, "/") == a.Iss)
		}
		switch {
		case iss == nil || iss.Host == "" || a.Handle == "":
			s.problem(w, 401, "assertion-invalid", "the assertion is malformed")
		case !trusted:
			s.problem(w, 403, "peer-not-trusted", "this instance does not accept identities from "+iss.Host)
		case doc["signature"] != assertionSig(payload):
			s.problem(w, 401, "assertion-invalid", "the signature does not verify")
		case a.Aud != s.URL:
			s.problem(w, 401, "assertion-invalid", "the assertion is for another audience")
		case !time.Now().Before(exp):
			s.problem(w, 401, "assertion-invalid", "the assertion has expired")
		case s.seenJTI[a.Jti]:
			s.problem(w, 401, "assertion-invalid", "the assertion was already used")
		default:
			s.seenJTI[a.Jti] = true
			key := fmt.Sprintf("af_fed_key_%010d", len(s.fedUsers)+1)
			fu := fedUser{id: a.Sub, handle: a.Handle + "@" + iss.Host}
			s.fedUsers[key] = fu
			label, _ := body["label"].(string)
			if label == "" {
				label = "federated login"
			}
			s.reply(w, r, tmpl, 201, map[string]any{
				"key":     key,
				"api_key": map[string]any{"id": fmt.Sprintf("key_%d", len(s.fedUsers)), "label": label, "prefix": key[:10], "created_at": now()},
				"user":    map[string]any{"id": fu.id, "handle": fu.handle, "role": "donor", "created_at": now()},
			})
		}
	case r.Method == "GET" && r.URL.Path == "/v1/me/claims":
		if !authed {
			s.problem(w, 401, "unauthorized", "missing or invalid API key")
			return
		}
		items := []any{}
		for i := s.nextClaim; i >= 1; i-- {
			c := s.claims[claimID(i)]
			if r.URL.Query().Get("active") == "true" && c.status != "active" {
				continue
			}
			items = append(items, map[string]any{
				"claim_id": claimID(i), "task_id": c.fullTask, "project": s.Slug, "status": c.status,
				"claimed_at": c.claimed.UTC().Format(time.RFC3339), "lease_expires_at": c.claimed.Add(2 * time.Hour).UTC().Format(time.RFC3339),
			})
		}
		s.reply(w, r, "/v1/me/claims", 200, map[string]any{"items": items})
	case r.Method == "GET" && reProject.MatchString(r.URL.Path):
		if reProject.FindStringSubmatch(r.URL.Path)[1] != s.Slug {
			s.problem(w, 404, "not-found", "no such project")
			return
		}
		s.reply(w, r, "/v1/projects/{slug}", 200, s.projectJSON())
	case r.Method == "GET" && reTasks.MatchString(r.URL.Path) && s.TasksRateLimited > 0:
		s.TasksRateLimited--
		w.Header().Set("Retry-After", fmt.Sprint(s.RetryAfterSeconds))
		s.problem(w, 429, "rate-limited", "slow down (fixture)")
	case r.Method == "GET" && reTasks.MatchString(r.URL.Path):
		items := []any{}
		for _, t := range s.Tasks {
			if r.URL.Query().Get("claimable") == "true" && (!t.Claimable || s.taskClaimed(t.ManifestID)) {
				continue
			}
			items = append(items, s.taskJSON(t))
		}
		s.reply(w, r, "/v1/projects/{slug}/tasks", 200, map[string]any{"items": items, "next_cursor": nil})
	case r.Method == "GET" && reTask.MatchString(r.URL.Path):
		m := reTask.FindStringSubmatch(r.URL.Path)
		for _, t := range s.Tasks {
			if m[1] == s.Slug && t.ManifestID == m[2] {
				tj := s.taskJSON(t)
				tj["claimable"] = t.Claimable && !s.taskClaimed(t.ManifestID)
				s.reply(w, r, "/v1/tasks/{task_id}", 200, tj)
				return
			}
		}
		s.problem(w, 404, "not-found", "no such task")
	case r.Method == "POST" && reClaim.MatchString(r.URL.Path):
		if !authed {
			s.problem(w, 401, "unauthorized", "missing or invalid API key")
			return
		}
		full := reClaim.FindStringSubmatch(r.URL.Path)[1]
		slug, mid, _ := strings.Cut(full, ":")
		var task *TaskSpec
		for i := range s.Tasks {
			if s.Tasks[i].ManifestID == mid && slug == s.Slug {
				task = &s.Tasks[i]
			}
		}
		switch {
		case task == nil:
			s.problem(w, 404, "not-found", "no such task")
		case s.ClaimProblem != "":
			s.problem(w, 409, s.ClaimProblem, "claim refused by fixture")
		case !task.Claimable || s.taskClaimed(mid):
			s.problem(w, 409, "task-not-open", "task is not open")
		default:
			s.nextClaim++
			id := claimID(s.nextClaim)
			claimCommit := s.Commit
			if s.ClaimCommit != "" {
				claimCommit = s.ClaimCommit
			}
			s.claims[id] = &claimState{task: *task, status: "active", claimed: time.Now(), fullTask: full}
			s.reply(w, r, "/v1/tasks/{task_id}/claim", 201, map[string]any{
				"claim_id": id, "task": s.taskJSON(*task), "project": s.Slug, "repo_url": s.RepoURL, "base_branch": "main",
				"commit": claimCommit, "content_hash": task.ContentHash, "lease_expires_at": now(),
				"lease_seconds": 7200, "heartbeat_interval_seconds": s.HeartbeatSeconds,
			})
		}
	case r.Method == "POST" && reClaimOp.MatchString(r.URL.Path):
		if !authed {
			s.problem(w, 401, "unauthorized", "missing or invalid API key")
			return
		}
		m := reClaimOp.FindStringSubmatch(r.URL.Path)
		c, ok := s.claims[m[1]]
		if !ok {
			s.problem(w, 404, "not-found", "no such claim")
			return
		}
		tmpl := "/v1/claims/{claim_id}/" + m[2]
		if err := s.validateRequest(tmpl, raw); err != nil {
			s.T.Errorf("worker sent a %s body that violates openapi.yaml: %v\n%s", m[2], err, raw)
			s.problem(w, 422, "validation", err.Error())
			return
		}
		if m[2] != "heartbeat" && s.ReportFailures > 0 {
			s.ReportFailures--
			s.problem(w, 503, "internal", "temporarily unavailable (fixture)")
			return
		}
		if m[2] == "report" && s.ReportProblem != "" {
			s.problem(w, 422, s.ReportProblem, "report refused by fixture")
			return
		}
		switch m[2] {
		case "heartbeat":
			if c.status == "active" && s.HeartbeatProblemAfter > 0 && s.heartbeats >= s.HeartbeatProblemAfter {
				c.status = "expired" // the lease ran out underneath the worker
			}
			if c.status != "active" {
				s.problem(w, 409, "claim-not-active", "claim is no longer active")
				return
			}
			s.heartbeats++
			c.beats = append(c.beats, body)
			s.reply(w, r, tmpl, 200, map[string]any{"lease_expires_at": now()})
		case "report":
			switch c.status {
			case "reported":
				s.problem(w, 409, "already-reported", "one report per claim")
				return
			case "released":
				s.problem(w, 409, "claim-not-active", "claim was released")
				return
			}
			late := c.status == "expired"
			if late && s.RejectLateReports {
				s.problem(w, 409, "claim-not-active", "late reports are refused by this fixture")
				return
			}
			if body["status"] == "completed" {
				want := "agentfund/" + c.task.ManifestID + "-" + strings.TrimPrefix(m[1], "clm_")[:8]
				if body["branch"] != want || body["pr_url"] == nil || body["head_sha"] == nil || body["verify_exit_code"] != float64(0) {
					s.problem(w, 422, "validation", "completed report needs branch "+want+", pr_url, head_sha and verify_exit_code 0")
					return
				}
			}
			c.status, c.report, c.late = "reported", body, late
			rep := map[string]any{
				"id": "rep_" + m[1][4:], "claim_id": m[1], "task_id": c.fullTask, "project": s.Slug,
				"donor":  map[string]any{"id": user.id, "handle": user.handle},
				"status": body["status"], "tokens_in": body["tokens_in"], "tokens_out": body["tokens_out"],
				"cost_estimate": body["cost_estimate"], "log_digest": body["log_digest"], "flagged_late": late,
				"delivery": map[bool]string{true: "pending_ci", false: "none"}[body["status"] == "completed" && !late], "created_at": now(),
			}
			s.reply(w, r, tmpl, 201, rep)
		case "release":
			if c.status != "active" {
				s.problem(w, 409, "claim-not-active", "claim is not active")
				return
			}
			c.status, c.release = "released", body
			if c.release == nil {
				c.release = map[string]any{}
			}
			w.WriteHeader(204)
		}
	default:
		s.problem(w, 404, "not-found", "no such route "+r.Method+" "+r.URL.Path)
	}
}

func now() string { return time.Now().UTC().Format(time.RFC3339) }

func (s *Server) taskClaimed(mid string) bool {
	for _, c := range s.claims {
		if c.task.ManifestID == mid && (c.status == "active" || (c.status == "reported" && c.report["status"] == "completed")) {
			return true
		}
	}
	return false
}

func (s *Server) projectJSON() map[string]any {
	totals := map[string]any{"pledged": 0, "reported": 0, "delivered": 0, "merged": 0, "in_flight": 0}
	return map[string]any{
		"id": s.URL + "/" + s.Slug, "slug": s.Slug, "name": "hello-project", "description": "fixture",
		"repo_url": s.RepoURL, "status": "active", "ci_provider": "generic", "base_branch": "main", "follow_branch": false,
		"maintainer": map[string]any{"id": s.URL + "/u/maint", "handle": "maint"},
		"pubkey":     s.Pubkey, "pubkey_fingerprint": s.Fingerprint, "pinned_commit": s.Commit, "lock_sha256": s.LockSHA256,
		"token_goal": 3000000, "totals": totals,
		"tasks":  map[string]any{"open": len(s.Tasks), "claimed": 0, "delivered": 0, "merged": 0, "failed": 0},
		"donors": 0, "velocity_7d": 0,
		"trust":      map[string]any{"tier": s.TrustTier, "merged_tasks": 0, "max_tokens_per_task": s.TrustTaskCap, "max_tokens_per_day": s.TrustDayCap},
		"created_at": now(),
	}
}

func (s *Server) taskJSON(t TaskSpec) map[string]any {
	scope := map[string]any{"write": t.Write}
	if t.Read != nil {
		scope["read"] = t.Read
	}
	deps := t.DependsOn
	if deps == nil {
		deps = []string{}
	}
	return map[string]any{
		"id": s.Slug + ":" + t.ManifestID, "task_id": t.ManifestID, "project": s.Slug, "title": t.Title, "state": "open",
		"content_hash": t.ContentHash, "manifest_path": "tasks/" + t.ManifestID + ".yaml", "commit": s.Commit,
		"manifest": map[string]any{
			"spec_version": 1, "id": t.ManifestID, "title": t.Title, "prompt": t.Prompt, "scope": scope,
			"verify": t.Verify, "max_tokens": t.MaxTokens, "depends_on": deps,
		},
		"depends_on": deps, "blocked_by": []string{}, "claimable": t.Claimable,
		"burn":       map[string]any{"tokens_in": 0, "tokens_out": 0, "total": 0, "runs": 0},
		"updated_at": now(),
	}
}

func (s *Server) operation(tmpl, method string) *openapi3.Operation {
	item := s.doc.Paths.Find(tmpl)
	if item == nil {
		s.T.Fatalf("openapi.yaml has no path %s", tmpl)
	}
	op := item.GetOperation(method)
	if op == nil {
		s.T.Fatalf("openapi.yaml has no %s %s", method, tmpl)
	}
	return op
}

func (s *Server) validateRequest(tmpl string, raw []byte) error {
	op := s.operation(tmpl, "POST")
	if op.RequestBody == nil {
		return nil
	}
	if len(raw) == 0 {
		if op.RequestBody.Value.Required {
			return fmt.Errorf("request body is required")
		}
		return nil
	}
	return ValidateJSON(op.RequestBody.Value.Content.Get("application/json").Schema.Value, raw)
}

// reply validates the payload against the documented response schema, then sends it.
func (s *Server) reply(w http.ResponseWriter, r *http.Request, tmpl string, status int, payload any) {
	raw, err := json.Marshal(payload)
	if err != nil {
		s.T.Fatalf("fake: %v", err)
	}
	op := s.operation(tmpl, r.Method)
	resp := op.Responses.Status(status)
	if resp == nil || resp.Value == nil {
		s.T.Fatalf("openapi.yaml documents no %d response for %s %s", status, r.Method, tmpl)
	}
	if mt := resp.Value.Content.Get("application/json"); mt != nil {
		if err := ValidateJSON(mt.Schema.Value, raw); err != nil {
			s.T.Errorf("fake response for %s %s violates openapi.yaml: %v\n%s", r.Method, tmpl, err, raw)
		}
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(raw)
}

func (s *Server) problem(w http.ResponseWriter, status int, code, detail string) {
	raw, _ := json.Marshal(map[string]any{"type": s.URL + "/problems/" + code, "title": code, "status": status, "detail": detail})
	if err := ValidateJSON(Schema(s.T, s.doc, "Problem"), raw); err != nil {
		s.T.Errorf("fake problem violates openapi.yaml: %v", err)
	}
	w.Header().Set("Content-Type", "application/problem+json")
	w.WriteHeader(status)
	_, _ = w.Write(raw)
}

// WaitFor polls until cond is true or the timeout elapses.
func WaitFor(ctx context.Context, timeout time.Duration, cond func() bool) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if cond() || ctx.Err() != nil {
			return cond()
		}
		time.Sleep(20 * time.Millisecond)
	}
	return cond()
}
