package runner

import (
	"encoding/json"
	"strings"
	"time"
)

// Meter turns a Claude Code stream-json event stream into cumulative usage.
//
// Verified shape (see CLAUDE_CODE_NOTES.md):
//   - every model call appears as `stream_event/message_start` (with
//     --include-partial-messages) and one or more `assistant` events sharing
//     message.id; their usage carries the real input/cache counts but only a
//     placeholder output count;
//   - `stream_event/message_delta` carries the response's cumulative output
//     count as it grows;
//   - the terminal `result` event carries `usage` (main loop only) and
//     `modelUsage` (per model, sub-agents included) plus `total_cost_usd`.
//
// While the run is in flight the meter counts each message id once (input
// side from message_start/assistant, output side from message_delta). When a
// `result` arrives its totals replace the running sum — they are the agent's
// own final accounting and include sub-agent calls — unless the result is
// zeroed (crash), in which case the running sum is kept.
type Meter struct {
	msgs    map[string]*msgUsage
	current map[string]string // parent_tool_use_id ("" = main loop) -> message id being streamed
	final   *Usage
	out     Outcome
	retries int
	// hardLimit is a definite refusal (assistant error, rejected window, 429
	// result); retryLimit is "the agent has been retrying for a while", which is
	// forgotten again if a later model call succeeds.
	hardLimit, retryLimit bool
	limitWhy              string
}

type msgUsage struct{ in, out int64 }

// NewMeter returns an empty meter.
func NewMeter() *Meter {
	return &Meter{msgs: map[string]*msgUsage{}, current: map[string]string{}}
}

type usageJSON struct {
	InputTokens              int64 `json:"input_tokens"`
	CacheCreationInputTokens int64 `json:"cache_creation_input_tokens"`
	CacheReadInputTokens     int64 `json:"cache_read_input_tokens"`
	OutputTokens             int64 `json:"output_tokens"`
}

func (u usageJSON) in() int64 {
	return u.InputTokens + u.CacheCreationInputTokens + u.CacheReadInputTokens
}

type event struct {
	Type    string `json:"type"`
	Subtype string `json:"subtype"`

	// system/init
	Model   string `json:"model"`
	Version string `json:"claude_code_version"`

	// assistant
	Message *struct {
		ID    string     `json:"id"`
		Model string     `json:"model"`
		Usage *usageJSON `json:"usage"`
	} `json:"message"`
	Error           string  `json:"error"`
	ParentToolUseID *string `json:"parent_tool_use_id"`

	// stream_event
	Event *struct {
		Type    string `json:"type"`
		Message *struct {
			ID    string     `json:"id"`
			Usage *usageJSON `json:"usage"`
		} `json:"message"`
		Usage *usageJSON `json:"usage"`
	} `json:"event"`

	// system/api_retry
	Attempt     int  `json:"attempt"`
	ErrorStatus *int `json:"error_status"`

	// rate_limit_event
	RateLimitInfo *struct {
		Status   string `json:"status"`
		ResetsAt int64  `json:"resetsAt"`
	} `json:"rate_limit_info"`

	// result
	IsError        bool       `json:"is_error"`
	Result         string     `json:"result"`
	TotalCostUSD   *float64   `json:"total_cost_usd"`
	Usage          *usageJSON `json:"usage"`
	APIErrorStatus *int       `json:"api_error_status"`
	ModelUsage     map[string]struct {
		InputTokens              int64 `json:"inputTokens"`
		OutputTokens             int64 `json:"outputTokens"`
		CacheReadInputTokens     int64 `json:"cacheReadInputTokens"`
		CacheCreationInputTokens int64 `json:"cacheCreationInputTokens"`
	} `json:"modelUsage"`
}

// Error categories Claude Code reports on assistant messages and api_retry
// events (docs: headless "Handle API retries", SDKAssistantMessageError).
const (
	errRateLimit  = "rate_limit"
	errOverloaded = "overloaded"
)

var credentialErrors = map[string]bool{
	"authentication_failed": true, "oauth_org_not_allowed": true, "account_on_hold": true,
	"billing_error": true, "cloud_credential_error": true,
}

// retriesBeforeGivingUp is how many consecutive rate-limit retries by the
// agent itself are tolerated before the run is treated as rate limited.
const retriesBeforeGivingUp = 3

func (m *Meter) msg(id string) *msgUsage {
	u, ok := m.msgs[id]
	if !ok {
		u = &msgUsage{}
		m.msgs[id] = u
	}
	return u
}

func parentKey(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

// Feed consumes one stream line. It returns true when the usage changed.
// Lines that are not JSON objects are ignored.
func (m *Meter) Feed(line []byte) bool {
	var ev event
	if len(line) == 0 || line[0] != '{' || json.Unmarshal(line, &ev) != nil {
		return false
	}
	before := m.Usage()
	switch ev.Type {
	case "system":
		switch ev.Subtype {
		case "init":
			if ev.Model != "" {
				m.out.Model = ev.Model
			}
			if ev.Version != "" {
				m.out.Version = "claude-code/" + ev.Version
			}
		case "api_retry":
			if ev.Error == errRateLimit || ev.Error == errOverloaded {
				m.retries++
				if m.retries >= retriesBeforeGivingUp {
					m.retryLimit = true
					m.note("the model API kept answering " + ev.Error + " after " + itoa(m.retries) + " retries")
				}
			}
			if credentialErrors[ev.Error] {
				m.out.CredentialProblem = ev.Error
			}
		}
	case "stream_event":
		if ev.Event == nil {
			break
		}
		key := parentKey(ev.ParentToolUseID)
		switch ev.Event.Type {
		case "message_start":
			if ev.Event.Message != nil && ev.Event.Message.ID != "" {
				m.current[key] = ev.Event.Message.ID
				if u := ev.Event.Message.Usage; u != nil {
					mu := m.msg(ev.Event.Message.ID)
					mu.in = max(mu.in, u.in())
					mu.out = max(mu.out, u.OutputTokens)
				}
				m.retries, m.retryLimit = 0, false
			}
		case "message_delta":
			if id := m.current[key]; id != "" && ev.Event.Usage != nil {
				mu := m.msg(id)
				mu.out = max(mu.out, ev.Event.Usage.OutputTokens)
				mu.in = max(mu.in, ev.Event.Usage.in())
			}
		}
	case "assistant":
		if ev.Message != nil && ev.Message.ID != "" && ev.Message.Usage != nil {
			mu := m.msg(ev.Message.ID)
			mu.in = max(mu.in, ev.Message.Usage.in())
			mu.out = max(mu.out, ev.Message.Usage.OutputTokens)
		}
		if ev.Message != nil && ev.Message.Model != "" && m.out.Model == "" {
			m.out.Model = ev.Message.Model
		}
		switch {
		case ev.Error == errRateLimit || ev.Error == errOverloaded:
			m.rateLimited("the model API answered " + ev.Error)
		case credentialErrors[ev.Error]:
			m.out.CredentialProblem = ev.Error
		}
	case "rate_limit_event":
		if ri := ev.RateLimitInfo; ri != nil {
			if ri.ResetsAt > 0 {
				m.out.ResetAt = time.Unix(ri.ResetsAt, 0)
			}
			if ri.Status == "rejected" {
				m.rateLimited("usage limit reached")
			}
		}
	case "result":
		m.out.ResultSeen = true
		m.out.IsError = ev.IsError || (ev.Subtype != "" && ev.Subtype != "success")
		if m.out.IsError {
			m.out.Message = truncate(firstNonEmpty(ev.Result, ev.Subtype), 500)
		}
		if ev.APIErrorStatus != nil && (*ev.APIErrorStatus == 429 || *ev.APIErrorStatus == 529) {
			m.rateLimited("the model API answered HTTP " + itoa(*ev.APIErrorStatus))
		}
		if ev.APIErrorStatus != nil && (*ev.APIErrorStatus == 401 || *ev.APIErrorStatus == 403) && m.out.CredentialProblem == "" {
			m.out.CredentialProblem = "authentication_failed"
		}
		var fin Usage
		for _, mu := range ev.ModelUsage {
			fin.TokensIn += mu.InputTokens + mu.CacheReadInputTokens + mu.CacheCreationInputTokens
			fin.TokensOut += mu.OutputTokens
		}
		if fin.Total() == 0 && ev.Usage != nil {
			fin.TokensIn, fin.TokensOut = ev.Usage.in(), ev.Usage.OutputTokens
		}
		if ev.TotalCostUSD != nil && *ev.TotalCostUSD > 0 {
			m.out.CostUSD = *ev.TotalCostUSD
		}
		if fin.Total() > 0 {
			m.final = &fin
		}
	}
	return m.Usage() != before
}

func (m *Meter) rateLimited(why string) {
	m.hardLimit = true
	m.note(why)
}

func (m *Meter) note(why string) {
	if m.limitWhy == "" {
		m.limitWhy = why
	}
}

// Usage returns the cumulative usage so far.
func (m *Meter) Usage() Usage {
	if m.final != nil {
		return Usage{TokensIn: m.final.TokensIn, TokensOut: m.final.TokensOut, CostUSD: m.out.CostUSD}
	}
	var u Usage
	for _, mu := range m.msgs {
		u.TokensIn += mu.in
		u.TokensOut += mu.out
	}
	u.CostUSD = m.out.CostUSD
	return u
}

// Outcome returns everything learned from the stream.
func (m *Meter) Outcome() Outcome {
	o := m.out
	o.Usage = m.Usage()
	o.Final = m.final != nil
	o.RateLimited = m.hardLimit || m.retryLimit
	if o.RateLimited && o.Message == "" {
		o.Message = m.limitWhy
	}
	return o
}

func firstNonEmpty(a ...string) string {
	for _, s := range a {
		if strings.TrimSpace(s) != "" {
			return s
		}
	}
	return ""
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

func itoa(n int) string {
	b, _ := json.Marshal(n)
	return string(b)
}
