package policy

import (
	"strings"
	"testing"
)

// Every cap refusal names the setting that caused it, with formatted amounts.
func TestRefusalsNameTheSetting(t *testing.T) {
	cases := []struct {
		name string
		mut  func(in *Input)
		want []string
	}{
		{"global task ceiling", func(in *Input) { in.MaxTokens = 6_000_000 }, []string{"global.max_tokens_per_task", "6M", "(5M)"}},
		{"project task ceiling", func(in *Input) { in.Project.MaxTokensPerTask = p64(500_000) }, []string{"this project's max_tokens_per_task", "(500k)"}},
		{"new-project ceiling", func(in *Input) { in.Trust.Tier = "new"; in.MaxTokens = 3_000_000 }, []string{"global.new_project_max_tokens_per_task", "3M", "(2M)"}},
		{"server task cap", func(in *Input) { in.Trust = Trust{Tier: "new", MaxTokensPerTask: p64(250_000)} }, []string{"the server publishes", "trust.max_tokens_per_task", "(250k)"}},
		{"daily", func(in *Input) { in.GlobalUsage.Day = 9_508_250 }, []string{"global.tokens_per_day", "9,508,250 used of 10M", "reserving 1M"}},
		{"weekly", func(in *Input) { in.GlobalUsage.Week = 39_500_000 }, []string{"global.tokens_per_week", "39,500,000 used of 40M"}},
		{"project daily", func(in *Input) { in.Project.TokensPerDay = p64(1000) }, []string{"this project's tokens_per_day", "of 1k"}},
		{"server daily", func(in *Input) { in.Trust.MaxTokensPerDay = p64(1000) }, []string{"trust.max_tokens_per_day"}},
		{"schedule", func(in *Input) { in.Global.Schedule = []Window{{Start: 0, End: 60}} }, []string{"global.schedule"}},
		{"concurrency", func(in *Input) { in.Active = 1 }, []string{"global.max_concurrent 1"}},
		{"git host", func(in *Input) { in.RepoURL = "https://gitlab.com/a/b" }, []string{"global.allowed_git_hosts", "gitlab.com"}},
	}
	for _, c := range cases {
		in := base()
		c.mut(&in)
		d := Evaluate(in)
		if d.Allow {
			t.Errorf("%s: allowed", c.name)
			continue
		}
		for _, w := range c.want {
			if !strings.Contains(d.Reason, w) {
				t.Errorf("%s: reason %q lacks %q", c.name, d.Reason, w)
			}
		}
	}
}
