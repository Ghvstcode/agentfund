package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/agentfund/agentfund/worker/internal/app"
)

// Problem codes the worker switches on (protocol.md §11).
const (
	CodeUnauthorized      = "unauthorized"
	CodeForbidden         = "forbidden"
	CodeBanned            = "banned"
	CodeNotFound          = "not-found"
	CodeValidation        = "validation"
	CodeTaskNotOpen       = "task-not-open"
	CodeDependenciesUnmet = "dependencies-unmet"
	CodeProjectNotActive  = "project-not-active"
	CodeClaimLimit        = "claim-limit"
	CodeProjectTaskCap    = "project-task-cap"
	CodeProjectDailyCap   = "project-daily-cap"
	CodeClaimNotActive    = "claim-not-active"
	CodeAlreadyReported   = "already-reported"
	CodeRateLimited       = "rate-limited"
	CodeInternal          = "internal"
	CodePeerNotTrusted    = "peer-not-trusted"
	CodeAssertionInvalid  = "assertion-invalid"
)

// Error is a non-2xx response.
type Error struct {
	HTTPStatus int
	Code       string // trailing segment of Problem.Type; "" when the body was not a problem document
	Problem    Problem
	RetryAfter time.Duration
}

func (e *Error) Error() string {
	msg := e.Problem.Title
	if e.Problem.Detail != "" {
		msg += ": " + e.Problem.Detail
	}
	if msg == "" {
		msg = http.StatusText(e.HTTPStatus)
	}
	code := e.Code
	if code == "" {
		code = "http-" + strconv.Itoa(e.HTTPStatus)
	}
	return fmt.Sprintf("server refused (%s): %s", code, msg)
}

// CodeOf returns the problem code of err, or "".
func CodeOf(err error) string {
	var e *Error
	if errors.As(err, &e) {
		return e.Code
	}
	return ""
}

// IsCode reports whether err is a server problem with one of the given codes.
func IsCode(err error, codes ...string) bool {
	c := CodeOf(err)
	return c != "" && slices.Contains(codes, c)
}

// Client talks to one instance.
type Client struct {
	BaseURL string
	APIKey  string
	HTTP    *http.Client
}

// New returns a client for the instance at baseURL.
func New(baseURL, apiKey string) *Client {
	return &Client{BaseURL: strings.TrimRight(baseURL, "/"), APIKey: apiKey, HTTP: &http.Client{Timeout: 60 * time.Second}}
}

const maxBody = 16 << 20

func (c *Client) do(ctx context.Context, method, path string, query url.Values, body, out any) error {
	u := c.BaseURL + path
	if len(query) > 0 {
		u += "?" + query.Encode()
	}
	var rd io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("encode request: %w", err)
		}
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, u, rd)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json, application/problem+json")
	req.Header.Set("User-Agent", app.UserAgent())
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if c.APIKey != "" {
		req.Header.Set("Authorization", "Bearer "+c.APIKey)
	}
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return fmt.Errorf("%s %s: %w", method, path, err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, maxBody))
	if err != nil {
		return fmt.Errorf("%s %s: read response: %w", method, path, err)
	}
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		if out == nil || len(raw) == 0 {
			return nil
		}
		if err := json.Unmarshal(raw, out); err != nil {
			return fmt.Errorf("%s %s: decode response: %w", method, path, err)
		}
		return nil
	}
	return decodeError(resp, raw)
}

func decodeError(resp *http.Response, raw []byte) error {
	e := &Error{HTTPStatus: resp.StatusCode}
	if ra := resp.Header.Get("Retry-After"); ra != "" {
		if secs, err := strconv.Atoi(ra); err == nil && secs >= 0 {
			e.RetryAfter = time.Duration(secs) * time.Second
		}
	}
	mt, _, _ := mime.ParseMediaType(resp.Header.Get("Content-Type"))
	if mt == "application/problem+json" || mt == "application/json" {
		if json.Unmarshal(raw, &e.Problem) == nil && e.Problem.Type != "" {
			e.Code = ProblemCode(e.Problem.Type)
		}
	}
	if e.Problem.Status == 0 {
		e.Problem.Status = resp.StatusCode
	}
	return e
}

// ProblemCode extracts the stable trailing code of a problem type URI.
func ProblemCode(typ string) string {
	if i := strings.IndexAny(typ, "?#"); i >= 0 {
		typ = typ[:i]
	}
	typ = strings.TrimRight(typ, "/")
	return typ[strings.LastIndex(typ, "/")+1:]
}

// Meta fetches instance metadata.
func (c *Client) Meta(ctx context.Context) (*Meta, error) {
	var m Meta
	return &m, c.do(ctx, http.MethodGet, "/v1/meta", nil, nil, &m)
}

// Negotiate fetches meta and refuses instances that do not speak protocol v1
// or do not support the given manifest spec version (protocol.md §2).
func (c *Client) Negotiate(ctx context.Context, specVersion int) (*Meta, error) {
	m, err := c.Meta(ctx)
	if err != nil {
		return nil, err
	}
	if !slices.Contains(m.ProtocolVersions, ProtocolVersion) {
		return nil, fmt.Errorf("instance %s does not speak protocol %s (offers %v)", c.BaseURL, ProtocolVersion, m.ProtocolVersions)
	}
	if !slices.Contains(m.SpecVersions, specVersion) {
		return nil, fmt.Errorf("instance %s does not support manifest spec_version %d (offers %v)", c.BaseURL, specVersion, m.SpecVersions)
	}
	return m, nil
}

// Me returns the authenticated user.
func (c *Client) Me(ctx context.Context) (*Me, error) {
	var m Me
	return &m, c.do(ctx, http.MethodGet, "/v1/me", nil, nil, &m)
}

// CreateIdentityAssertion asks this instance (the caller's home) for a
// short-lived signed identity assertion that only audience will accept.
func (c *Client) CreateIdentityAssertion(ctx context.Context, audience string) (*IdentityAssertion, error) {
	var a IdentityAssertion
	return &a, c.do(ctx, http.MethodPost, "/v1/federation/assertions", nil, AssertionRequest{Audience: audience}, &a)
}

// AuthFederated exchanges a peer's identity assertion for an API key on this
// instance. The request is sent without an Authorization header.
func (c *Client) AuthFederated(ctx context.Context, assertion SignedDocument, label string) (*FederatedAuth, error) {
	anon := *c
	anon.APIKey = ""
	var f FederatedAuth
	return &f, anon.do(ctx, http.MethodPost, "/v1/auth/federated", nil, FederatedAuthRequest{Assertion: assertion, Label: label}, &f)
}

// Project fetches a project.
func (c *Client) Project(ctx context.Context, slug string) (*Project, error) {
	var p Project
	return &p, c.do(ctx, http.MethodGet, "/v1/projects/"+url.PathEscape(slug), nil, nil, &p)
}

// Tasks lists every task of a project (following cursors), optionally only claimable ones.
func (c *Client) Tasks(ctx context.Context, slug string, claimableOnly bool) ([]Task, error) {
	var all []Task
	cursor := ""
	for page := 0; page < 100; page++ {
		q := url.Values{"limit": {"100"}}
		if claimableOnly {
			q.Set("claimable", "true")
		}
		if cursor != "" {
			q.Set("cursor", cursor)
		}
		var tp TaskPage
		if err := c.do(ctx, http.MethodGet, "/v1/projects/"+url.PathEscape(slug)+"/tasks", q, nil, &tp); err != nil {
			return nil, err
		}
		all = append(all, tp.Items...)
		if tp.NextCursor == nil || *tp.NextCursor == "" {
			break
		}
		cursor = *tp.NextCursor
	}
	return all, nil
}

// Task fetches one task by its "<slug>:<manifest id>" reference.
func (c *Client) Task(ctx context.Context, taskID string) (*Task, error) {
	var t Task
	return &t, c.do(ctx, http.MethodGet, "/v1/tasks/"+url.PathEscape(taskID), nil, nil, &t)
}

// Claim atomically claims a task ("<slug>:<manifest id>").
func (c *Client) Claim(ctx context.Context, taskID string) (*Claim, error) {
	var cl Claim
	return &cl, c.do(ctx, http.MethodPost, "/v1/tasks/"+url.PathEscape(taskID)+"/claim", nil, nil, &cl)
}

// Heartbeat extends the lease and publishes in-flight usage.
func (c *Client) Heartbeat(ctx context.Context, claimID string, hb HeartbeatRequest) (*HeartbeatResponse, error) {
	var r HeartbeatResponse
	return &r, c.do(ctx, http.MethodPost, "/v1/claims/"+url.PathEscape(claimID)+"/heartbeat", nil, hb, &r)
}

// Report submits the single report of a claim.
func (c *Client) Report(ctx context.Context, claimID string, rep ReportCreate) (*Report, error) {
	var r Report
	return &r, c.do(ctx, http.MethodPost, "/v1/claims/"+url.PathEscape(claimID)+"/report", nil, rep, &r)
}

// Release voluntarily gives a claim back.
func (c *Client) Release(ctx context.Context, claimID string, rel ReleaseRequest) error {
	return c.do(ctx, http.MethodPost, "/v1/claims/"+url.PathEscape(claimID)+"/release", nil, rel, nil)
}

// MyClaims lists the caller's recent claims.
func (c *Client) MyClaims(ctx context.Context, activeOnly bool) ([]ClaimSummary, error) {
	q := url.Values{"limit": {"50"}}
	if activeOnly {
		q.Set("active", "true")
	}
	var l ClaimList
	return l.Items, c.do(ctx, http.MethodGet, "/v1/me/claims", q, nil, &l)
}
