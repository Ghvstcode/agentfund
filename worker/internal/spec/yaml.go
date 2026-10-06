package spec

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"math/big"
	"regexp"
	"strconv"
	"strings"

	"gopkg.in/yaml.v3"
)

// MaxYAMLBytes bounds the size of any YAML document the worker parses.
const MaxYAMLBytes = 1 << 20

var (
	reNull  = regexp.MustCompile(`^(~|null|Null|NULL|)$`)
	reBool  = regexp.MustCompile(`^(true|True|TRUE|false|False|FALSE)$`)
	reInt   = regexp.MustCompile(`^[-+]?[0-9]+$`)
	reOct   = regexp.MustCompile(`^0o[0-7]+$`)
	reHex   = regexp.MustCompile(`^0x[0-9a-fA-F]+$`)
	reFloat = regexp.MustCompile(`^[-+]?(\.[0-9]+|[0-9]+(\.[0-9]*)?)([eE][-+]?[0-9]+)?$`)
	reInf   = regexp.MustCompile(`^[-+]?\.(inf|Inf|INF)$`)
	reNaN   = regexp.MustCompile(`^\.(nan|NaN|NAN)$`)
)

// ParseYAML parses exactly one YAML document using the YAML 1.2 core schema
// and returns plain Go values (map[string]any, []any, string, bool,
// json.Number, float64, nil).
//
// Per spec/manifest.md §1 it rejects anchors, aliases, merge keys, explicit
// tags and multiple documents. It additionally rejects duplicate and
// non-scalar mapping keys, which have no JSON meaning.
func ParseYAML(data []byte) (any, error) {
	if len(data) > MaxYAMLBytes {
		return nil, fmt.Errorf("yaml: document larger than %d bytes", MaxYAMLBytes)
	}
	dec := yaml.NewDecoder(bytes.NewReader(data))
	var doc yaml.Node
	if err := dec.Decode(&doc); err != nil {
		if errors.Is(err, io.EOF) {
			return nil, errors.New("yaml: empty document")
		}
		return nil, fmt.Errorf("yaml: %w", err)
	}
	var extra yaml.Node
	if err := dec.Decode(&extra); !errors.Is(err, io.EOF) {
		if err != nil {
			return nil, fmt.Errorf("yaml: %w", err)
		}
		return nil, errors.New("yaml: multiple documents are not allowed")
	}
	if doc.Kind != yaml.DocumentNode || len(doc.Content) != 1 {
		return nil, errors.New("yaml: expected a single document")
	}
	return convert(doc.Content[0], 0)
}

func convert(n *yaml.Node, depth int) (any, error) {
	if depth > 64 {
		return nil, errors.New("yaml: nesting too deep")
	}
	at := func(msg string) error { return fmt.Errorf("yaml: line %d: %s", n.Line, msg) }
	if n.Anchor != "" {
		return nil, at("anchors are not allowed")
	}
	if n.Kind == yaml.AliasNode || n.Alias != nil {
		return nil, at("aliases are not allowed")
	}
	if n.Style&yaml.TaggedStyle != 0 {
		return nil, at("explicit tags are not allowed")
	}
	switch n.Kind {
	case yaml.ScalarNode:
		if n.Tag != "" && !strings.HasPrefix(n.Tag, "!!") {
			return nil, at("explicit tags are not allowed")
		}
		if n.Style&(yaml.SingleQuotedStyle|yaml.DoubleQuotedStyle|yaml.LiteralStyle|yaml.FoldedStyle) != 0 {
			return n.Value, nil
		}
		return resolvePlain(n.Value), nil
	case yaml.SequenceNode:
		if n.Tag != "" && n.Tag != "!!seq" {
			return nil, at("explicit tags are not allowed")
		}
		out := make([]any, 0, len(n.Content))
		for _, c := range n.Content {
			v, err := convert(c, depth+1)
			if err != nil {
				return nil, err
			}
			out = append(out, v)
		}
		return out, nil
	case yaml.MappingNode:
		if n.Tag != "" && n.Tag != "!!map" {
			return nil, at("explicit tags are not allowed")
		}
		out := make(map[string]any, len(n.Content)/2)
		for i := 0; i+1 < len(n.Content); i += 2 {
			k, v := n.Content[i], n.Content[i+1]
			if k.Kind != yaml.ScalarNode {
				return nil, fmt.Errorf("yaml: line %d: mapping keys must be scalars", k.Line)
			}
			if k.Anchor != "" || k.Style&yaml.TaggedStyle != 0 {
				return nil, fmt.Errorf("yaml: line %d: anchors and tags are not allowed", k.Line)
			}
			if k.Value == "<<" && k.Style&(yaml.SingleQuotedStyle|yaml.DoubleQuotedStyle) == 0 {
				return nil, fmt.Errorf("yaml: line %d: merge keys are not allowed", k.Line)
			}
			if _, dup := out[k.Value]; dup {
				return nil, fmt.Errorf("yaml: line %d: duplicate key %q", k.Line, k.Value)
			}
			val, err := convert(v, depth+1)
			if err != nil {
				return nil, err
			}
			out[k.Value] = val
		}
		return out, nil
	default:
		return nil, at("unsupported node")
	}
}

// resolvePlain applies the YAML 1.2 core schema to a plain scalar.
func resolvePlain(s string) any {
	switch {
	case reNull.MatchString(s):
		return nil
	case reBool.MatchString(s):
		return s[0] == 't' || s[0] == 'T'
	case reInt.MatchString(s):
		if b, ok := new(big.Int).SetString(strings.TrimPrefix(s, "+"), 10); ok {
			return json.Number(b.String())
		}
	case reOct.MatchString(s):
		if b, ok := new(big.Int).SetString(s[2:], 8); ok {
			return json.Number(b.String())
		}
	case reHex.MatchString(s):
		if b, ok := new(big.Int).SetString(s[2:], 16); ok {
			return json.Number(b.String())
		}
	case reFloat.MatchString(s):
		if f, err := strconv.ParseFloat(s, 64); err == nil && !math.IsInf(f, 0) {
			return f
		}
	case reInf.MatchString(s), reNaN.MatchString(s):
		// Not representable in JSON; schema validation will reject the string.
		return s
	}
	return s
}
