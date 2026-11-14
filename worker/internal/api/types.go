// Package api is a thin client for the AgentFund wire protocol v1
// (spec/openapi.yaml, spec/protocol.md). Types mirror the OpenAPI schemas; a
// test compares them against the spec so drift is caught.
package api

import (
	"encoding/json"
	"time"
)

// ProtocolVersion is the protocol version this client speaks.
const ProtocolVersion = "v1"

// Meta is GET /v1/meta.
type Meta struct {
	App              string          `json:"app"`
	Name             string          `json:"name"`
	Description      string          `json:"description,omitempty"`
	Version          string          `json:"version"`
	BaseURL          string          `json:"base_url"`
	ProtocolVersions []string        `json:"protocol_versions"`
	SpecVersions     []int           `json:"spec_versions"`
	InstancePubkey   string          `json:"instance_pubkey,omitempty"`
	Capabilities     json.RawMessage `json:"capabilities"`
	Links            *MetaLinks      `json:"links,omitempty"`
	Defaults         *MetaDefaults   `json:"defaults,omitempty"`
}

// Federation reports capabilities.federation: the instance serves
// POST /v1/federation/assertions and POST /v1/auth/federated.
func (m *Meta) Federation() bool {
	var c struct {
		Federation bool `json:"federation"`
	}
	return json.Unmarshal(m.Capabilities, &c) == nil && c.Federation
}

// MetaLinks are operator-configured pointers.
type MetaLinks struct {
	SourceURL      string `json:"source_url,omitempty"`
	InstallCommand string `json:"install_command,omitempty"`
	DocsURL        string `json:"docs_url,omitempty"`
}

// MetaDefaults are the instance's lease defaults.
type MetaDefaults struct {
	LeaseSeconds             int `json:"lease_seconds,omitempty"`
	HeartbeatIntervalSeconds int `json:"heartbeat_interval_seconds,omitempty"`
}

// UserRef identifies a user.
type UserRef struct {
	ID        string  `json:"id"`
	Handle    string  `json:"handle"`
	AvatarURL *string `json:"avatar_url,omitempty"`
}

// Me is GET /v1/me.
type Me struct {
	ID          string    `json:"id"`
	Handle      string    `json:"handle"`
	AvatarURL   *string   `json:"avatar_url,omitempty"`
	Role        string    `json:"role"`
	Email       *string   `json:"email,omitempty"`
	GithubLogin *string   `json:"github_login,omitempty"`
	Banned      bool      `json:"banned,omitempty"`
	CreatedAt   time.Time `json:"created_at"`
}

// ProjectTrust is the server-computed reputation; an upper bound on policy only.
type ProjectTrust struct {
	Tier             string `json:"tier"`
	MergedTasks      int    `json:"merged_tasks"`
	MaxTokensPerTask *int64 `json:"max_tokens_per_task"`
	MaxTokensPerDay  *int64 `json:"max_tokens_per_day"`
}

// Project is GET /v1/projects/{slug} (the fields the worker uses).
type Project struct {
	ID                string       `json:"id"`
	Slug              string       `json:"slug"`
	Name              string       `json:"name"`
	Description       string       `json:"description"`
	RepoURL           string       `json:"repo_url"`
	Status            string       `json:"status"`
	CIProvider        string       `json:"ci_provider"`
	BaseBranch        string       `json:"base_branch"`
	FollowBranch      bool         `json:"follow_branch"`
	Maintainer        UserRef      `json:"maintainer"`
	Pubkey            string       `json:"pubkey"`
	PubkeyFingerprint string       `json:"pubkey_fingerprint"`
	PinnedCommit      string       `json:"pinned_commit"`
	LockSHA256        *string      `json:"lock_sha256,omitempty"`
	CommitURL         *string      `json:"commit_url,omitempty"`
	TokenGoal         int64        `json:"token_goal"`
	Trust             ProjectTrust `json:"trust"`
	IndexError        *string      `json:"index_error,omitempty"`
}

// Manifest is the server's parsed copy of a manifest. It is informational:
// the worker executes only what it verified from the repository itself.
type Manifest struct {
	SpecVersion    int      `json:"spec_version"`
	ID             string   `json:"id"`
	Title          string   `json:"title"`
	Prompt         string   `json:"prompt"`
	Scope          Scope    `json:"scope"`
	Verify         string   `json:"verify"`
	MaxTokens      int64    `json:"max_tokens"`
	TimeoutMinutes int      `json:"timeout_minutes,omitempty"`
	DependsOn      []string `json:"depends_on,omitempty"`
	BaseBranch     string   `json:"base_branch,omitempty"`
}

// Scope is a manifest scope.
type Scope struct {
	Write []string `json:"write"`
	Read  []string `json:"read,omitempty"`
}

// Task is one task row.
type Task struct {
	ID           string    `json:"id"`      // <slug>:<manifest id>
	TaskID       string    `json:"task_id"` // manifest id
	Project      string    `json:"project"`
	Title        string    `json:"title"`
	State        string    `json:"state"`
	ContentHash  string    `json:"content_hash"`
	ManifestPath string    `json:"manifest_path"`
	Commit       string    `json:"commit"`
	Manifest     Manifest  `json:"manifest"`
	DependsOn    []string  `json:"depends_on"`
	BlockedBy    []string  `json:"blocked_by"`
	Claimable    bool      `json:"claimable"`
	UpdatedAt    time.Time `json:"updated_at"`
}

// TaskPage is one page of GET /v1/projects/{slug}/tasks.
type TaskPage struct {
	Items      []Task  `json:"items"`
	NextCursor *string `json:"next_cursor"`
}

// Claim is the response of POST /v1/tasks/{task_id}/claim.
type Claim struct {
	ClaimID                  string    `json:"claim_id"`
	Task                     Task      `json:"task"`
	Project                  string    `json:"project"`
	RepoURL                  string    `json:"repo_url"`
	BaseBranch               string    `json:"base_branch"`
	Commit                   string    `json:"commit"`
	ContentHash              string    `json:"content_hash"`
	LeaseExpiresAt           time.Time `json:"lease_expires_at"`
	LeaseSeconds             int       `json:"lease_seconds"`
	HeartbeatIntervalSeconds int       `json:"heartbeat_interval_seconds"`
}

// Heartbeat phases.
const (
	PhaseVerifying = "verifying"
	PhaseSandbox   = "sandbox"
	PhaseAgent     = "agent"
	PhaseVerify    = "verify"
	PhasePushing   = "pushing"
)

// HeartbeatRequest is the body of POST /v1/claims/{id}/heartbeat.
type HeartbeatRequest struct {
	TokensIn  *int64 `json:"tokens_in,omitempty"`
	TokensOut *int64 `json:"tokens_out,omitempty"`
	Phase     string `json:"phase,omitempty"`
}

// HeartbeatResponse is its response.
type HeartbeatResponse struct {
	LeaseExpiresAt time.Time `json:"lease_expires_at"`
}

// Report statuses.
const (
	StatusCompleted          = "completed"
	StatusFailed             = "failed"
	StatusVerificationFailed = "verification_failed"
	StatusBudgetExceeded     = "budget_exceeded"
	StatusTimeout            = "timeout"
)

// ReportCreate is the body of POST /v1/claims/{id}/report.
type ReportCreate struct {
	Status          string  `json:"status"`
	TokensIn        int64   `json:"tokens_in"`
	TokensOut       int64   `json:"tokens_out"`
	CostEstimate    float64 `json:"cost_estimate"`
	Branch          *string `json:"branch,omitempty"`
	PRURL           *string `json:"pr_url,omitempty"`
	HeadSHA         *string `json:"head_sha,omitempty"`
	VerifyExitCode  *int    `json:"verify_exit_code,omitempty"`
	LogDigest       string  `json:"log_digest"`
	DurationSeconds *int64  `json:"duration_seconds,omitempty"`
	Runner          string  `json:"runner,omitempty"`
	Model           string  `json:"model,omitempty"`
	Message         string  `json:"message,omitempty"`
}

// Report is a stored report.
type Report struct {
	ID           string    `json:"id"`
	ClaimID      string    `json:"claim_id"`
	TaskID       string    `json:"task_id"`
	Project      string    `json:"project"`
	Donor        UserRef   `json:"donor"`
	Status       string    `json:"status"`
	TokensIn     int64     `json:"tokens_in"`
	TokensOut    int64     `json:"tokens_out"`
	CostEstimate float64   `json:"cost_estimate"`
	Branch       *string   `json:"branch,omitempty"`
	PRURL        *string   `json:"pr_url,omitempty"`
	HeadSHA      *string   `json:"head_sha,omitempty"`
	LogDigest    string    `json:"log_digest"`
	FlaggedLate  bool      `json:"flagged_late"`
	Delivery     string    `json:"delivery"`
	CreatedAt    time.Time `json:"created_at"`
}

// ReleaseRequest is the body of POST /v1/claims/{id}/release.
type ReleaseRequest struct {
	Reason    string `json:"reason,omitempty"`
	TokensIn  *int64 `json:"tokens_in,omitempty"`
	TokensOut *int64 `json:"tokens_out,omitempty"`
}

// ClaimSummary is one row of GET /v1/me/claims.
type ClaimSummary struct {
	ClaimID        string    `json:"claim_id"`
	TaskID         string    `json:"task_id"`
	Project        string    `json:"project"`
	Status         string    `json:"status"`
	ClaimedAt      time.Time `json:"claimed_at"`
	LeaseExpiresAt time.Time `json:"lease_expires_at"`
	Report         *Report   `json:"report,omitempty"`
}

// ClaimList is GET /v1/me/claims.
type ClaimList struct {
	Items []ClaimSummary `json:"items"`
}

// Problem is an RFC 9457 error body.
type Problem struct {
	Type     string         `json:"type"`
	Title    string         `json:"title"`
	Status   int            `json:"status"`
	Detail   string         `json:"detail,omitempty"`
	Instance string         `json:"instance,omitempty"`
	Errors   []ProblemError `json:"errors,omitempty"`
}

// ProblemError is one validation error.
type ProblemError struct {
	Path    string `json:"path,omitempty"`
	Message string `json:"message,omitempty"`
}

// SignedDocument is a statement signed with an instance key. The worker
// carries it from one instance to another and never alters payload.
type SignedDocument struct {
	Payload   string `json:"payload"`
	Signature string `json:"signature"`
}

// AssertionRequest is the body of POST /v1/federation/assertions.
type AssertionRequest struct {
	Audience string `json:"audience"`
}

// IdentityAssertion is the response of POST /v1/federation/assertions.
type IdentityAssertion struct {
	Assertion SignedDocument `json:"assertion"`
	ExpiresAt time.Time      `json:"expires_at"`
}

// FederatedAuthRequest is the body of POST /v1/auth/federated.
type FederatedAuthRequest struct {
	Assertion SignedDocument `json:"assertion"`
	Label     string         `json:"label,omitempty"`
}

// APIKeyInfo describes an API key (never the secret itself).
type APIKeyInfo struct {
	ID         string     `json:"id"`
	Label      string     `json:"label"`
	Prefix     string     `json:"prefix"`
	CreatedAt  time.Time  `json:"created_at"`
	LastUsedAt *time.Time `json:"last_used_at,omitempty"`
	RevokedAt  *time.Time `json:"revoked_at,omitempty"`
}

// FederatedAuth is the response of POST /v1/auth/federated. Key is the secret, shown once.
type FederatedAuth struct {
	Key    string     `json:"key"`
	APIKey APIKeyInfo `json:"api_key"`
	User   Me         `json:"user"`
}
