// Package spec implements the normative manifest spec (spec/manifest.md):
// strict YAML parsing, JSON Schema validation against the embedded schemas,
// typed manifests and glob semantics.
package spec

//go:generate sh -c "cp ../../../spec/schemas/*.json schemas/"

import (
	"bytes"
	"embed"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"sync"

	"github.com/santhosh-tekuri/jsonschema/v6"
)

// SpecVersion is the only manifest spec version this worker understands.
const SpecVersion = 1

//go:embed schemas/*.json
var schemaFS embed.FS

// Schema names.
const (
	SchemaManifest   = "manifest.schema.json"
	SchemaDescriptor = "agentfund.schema.json"
	SchemaLock       = "lock.schema.json"
)

// SchemaBytes returns the embedded copy of a schema file.
func SchemaBytes(name string) ([]byte, error) { return schemaFS.ReadFile("schemas/" + name) }

var (
	compileOnce sync.Once
	compiled    map[string]*jsonschema.Schema
	compileErr  error
)

func schema(name string) (*jsonschema.Schema, error) {
	compileOnce.Do(func() {
		compiled = map[string]*jsonschema.Schema{}
		c := jsonschema.NewCompiler()
		c.AssertFormat()
		c.DefaultDraft(jsonschema.Draft2020)
		names := []string{SchemaManifest, SchemaDescriptor, SchemaLock}
		for _, n := range names {
			raw, err := SchemaBytes(n)
			if err != nil {
				compileErr = err
				return
			}
			doc, err := jsonschema.UnmarshalJSON(bytes.NewReader(raw))
			if err != nil {
				compileErr = fmt.Errorf("schema %s: %w", n, err)
				return
			}
			if err := c.AddResource("embedded:///"+n, doc); err != nil {
				compileErr = fmt.Errorf("schema %s: %w", n, err)
				return
			}
		}
		for _, n := range names {
			s, err := c.Compile("embedded:///" + n)
			if err != nil {
				compileErr = fmt.Errorf("schema %s: %w", n, err)
				return
			}
			compiled[n] = s
		}
	})
	if compileErr != nil {
		return nil, compileErr
	}
	return compiled[name], nil
}

// SchemaError lists every violation found by schema validation.
type SchemaError struct {
	Schema string
	Issues []string
}

func (e *SchemaError) Error() string {
	return fmt.Sprintf("does not match %s: %s", e.Schema, strings.Join(e.Issues, "; "))
}

// Validate checks a parsed document (as produced by ParseYAML or
// jsonschema.UnmarshalJSON) against the named embedded schema.
func Validate(name string, doc any) error {
	s, err := schema(name)
	if err != nil {
		return err
	}
	err = s.Validate(doc)
	if err == nil {
		return nil
	}
	ve, ok := err.(*jsonschema.ValidationError)
	if !ok {
		return err
	}
	var issues []string
	var walk func(v *jsonschema.ValidationError)
	walk = func(v *jsonschema.ValidationError) {
		if len(v.Causes) == 0 {
			loc := "/" + strings.Join(v.InstanceLocation, "/")
			issues = append(issues, loc+" "+v.ErrorKind.LocalizedString(defaultPrinter))
			return
		}
		for _, c := range v.Causes {
			walk(c)
		}
	}
	walk(ve)
	sort.Strings(issues)
	return &SchemaError{Schema: name, Issues: issues}
}

// ValidateJSON parses raw JSON (rejecting trailing data) and validates it.
func ValidateJSON(name string, raw []byte) error {
	doc, err := jsonschema.UnmarshalJSON(bytes.NewReader(raw))
	if err != nil {
		return fmt.Errorf("invalid JSON: %w", err)
	}
	return Validate(name, doc)
}

// decodeInto converts a validated generic document into a typed struct.
func decodeInto(doc any, out any) error {
	b, err := json.Marshal(doc)
	if err != nil {
		return err
	}
	d := json.NewDecoder(bytes.NewReader(b))
	d.DisallowUnknownFields()
	return d.Decode(out)
}
