import { parseAllDocuments, visit, isAlias, isScalar, isPair, type Node } from "yaml";

export class StrictYamlError extends Error {}

/**
 * Parses exactly one YAML 1.2 core-schema document and rejects everything the manifest spec
 * forbids: anchors, aliases, merge keys, explicit tags, directives and multiple documents.
 */
export function parseStrictYaml(text: string): unknown {
  if (text.charCodeAt(0) === 0xfeff) throw new StrictYamlError("byte order mark is not allowed");
  const docs = parseAllDocuments(text, { version: "1.2", schema: "core", strict: true, uniqueKeys: true, merge: false, prettyErrors: false });
  if (docs.length !== 1) throw new StrictYamlError(docs.length === 0 ? "empty document" : "multiple YAML documents are not allowed");
  const doc = docs[0]!;
  if (doc.errors.length) throw new StrictYamlError(doc.errors[0]!.message);
  if (doc.directives && (doc.directives.yaml.explicit || Object.keys(doc.directives.tags).some((t) => t !== "!!"))) {
    throw new StrictYamlError("YAML directives are not allowed");
  }
  if (/^%(YAML|TAG)\b/m.test(text.split(/^---/m)[0] ?? "")) throw new StrictYamlError("YAML directives are not allowed");
  const check = (node: Node | null): void => {
    if (!node) return;
    if (isAlias(node)) throw new StrictYamlError("aliases are not allowed");
    if ((node as { anchor?: string }).anchor) throw new StrictYamlError("anchors are not allowed");
    if (node.tag) throw new StrictYamlError(`explicit tags are not allowed (${node.tag})`);
  };
  visit(doc, {
    Alias: () => {
      throw new StrictYamlError("aliases are not allowed");
    },
    Node: (_key, node) => check(node as Node),
    Pair: (_key, pair) => {
      if (isPair(pair) && isScalar(pair.key) && pair.key.value === "<<") throw new StrictYamlError("merge keys are not allowed");
    },
  });
  return doc.toJS({ maxAliasCount: 0 });
}
