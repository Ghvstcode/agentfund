package config

import (
	"fmt"
	"math"
	"strconv"
	"strings"

	"gopkg.in/yaml.v3"

	"github.com/agentfund/agentfund/worker/internal/tokfmt"
)

// Tokens is a token quantity that reads "200m", "5M", "750k", "1.5m" or a plain integer.
type Tokens int64

// ParseTokens parses a budget string. Suffixes (case-insensitive): k = 1e3,
// m = 1e6, g or b = 1e9. Underscores and commas are ignored.
func ParseTokens(s string) (Tokens, error) {
	orig := s
	s = strings.ToLower(strings.TrimSpace(s))
	s = strings.NewReplacer("_", "", ",", "").Replace(s)
	if s == "" {
		return 0, fmt.Errorf("empty token amount")
	}
	mult := 1.0
	switch s[len(s)-1] {
	case 'k':
		mult, s = 1e3, s[:len(s)-1]
	case 'm':
		mult, s = 1e6, s[:len(s)-1]
	case 'g', 'b':
		mult, s = 1e9, s[:len(s)-1]
	}
	if mult == 1 {
		n, err := strconv.ParseInt(s, 10, 64)
		if err != nil || n < 0 {
			return 0, fmt.Errorf("invalid token amount %q (use e.g. 200m, 5M, 750k or an integer)", orig)
		}
		return Tokens(n), nil
	}
	f, err := strconv.ParseFloat(s, 64)
	if err != nil || f < 0 || math.IsNaN(f) || f*mult > math.MaxInt64/2 {
		return 0, fmt.Errorf("invalid token amount %q (use e.g. 200m, 5M, 750k or an integer)", orig)
	}
	return Tokens(math.Round(f * mult)), nil
}

// String renders the amount for people (see tokfmt.Format): 10M, 750k, 8,250.
func (t Tokens) String() string { return tokfmt.Format(int64(t)) }

// yamlForm is what is written to config.yaml: the compact form for round
// amounts, plain digits otherwise.
func (t Tokens) yamlForm() string {
	if c := tokfmt.Compact(int64(t)); c != "" {
		return c
	}
	return strconv.FormatInt(int64(t), 10)
}

// UnmarshalYAML accepts integers and suffixed strings.
func (t *Tokens) UnmarshalYAML(n *yaml.Node) error {
	v, err := ParseTokens(n.Value)
	if err != nil {
		return fmt.Errorf("line %d: %w", n.Line, err)
	}
	*t = v
	return nil
}

// MarshalYAML writes the compact form.
func (t Tokens) MarshalYAML() (any, error) { return t.yamlForm(), nil }
