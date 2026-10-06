/**
 * The OpenAPI document is the contract, so the server validates requests with the very
 * schemas it publishes: one Ajv validator per operation for path, query and JSON body.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import { parse } from "yaml";
import { SPEC_DIR } from "../paths.js";
import type { components, operations } from "../generated/openapi.js";
import type { FieldError } from "./problem.js";

// ajv-formats ships CJS with a default export; NodeNext sees the namespace.
const addFormats = addFormatsModule as unknown as (ajv: Ajv2020) => void;

export type Schemas = components["schemas"];
export type OperationId = keyof operations;
export type Method = "get" | "post" | "patch" | "delete" | "put";
export type AuthScheme = "session" | "donorKey" | "webhookSignature";

type JsonContent<T> = T extends { content: { "application/json": infer B } } ? B : never;
export type BodyOf<K extends OperationId> = operations[K] extends { requestBody?: infer R } ? JsonContent<NonNullable<R>> : never;
export type QueryOf<K extends OperationId> = NonNullable<operations[K]["parameters"]["query"]>;
export type PathOf<K extends OperationId> = NonNullable<operations[K]["parameters"]["path"]>;
export type ResponseOf<K extends OperationId, S extends keyof operations[K]["responses"]> = JsonContent<operations[K]["responses"][S]>;

interface RawParameter {
  name: string;
  in: "query" | "path" | "header";
  required?: boolean;
  schema?: Record<string, unknown>;
}
interface RawOperation {
  operationId: string;
  tags?: string[];
  security?: Record<string, string[]>[];
  parameters?: (RawParameter | { $ref: string })[];
  requestBody?: { required?: boolean; content?: Record<string, { schema?: Record<string, unknown> }> };
  responses: Record<string, unknown>;
}
interface RawDocument {
  paths: Record<string, Record<string, unknown>>;
  components: { parameters: Record<string, RawParameter>; schemas: Record<string, unknown>; responses: Record<string, unknown> };
}

export interface Operation {
  id: OperationId;
  method: Method;
  /** OpenAPI template, e.g. `/v1/projects/{slug}`. */
  path: string;
  /** Hono pattern, e.g. `/v1/projects/:slug`. */
  route: string;
  tags: string[];
  schemes: AuthScheme[];
  bodyRequired: boolean;
  hasBody: boolean;
  validatePath: ValidateFunction | null;
  validateQuery: ValidateFunction | null;
  validateBody: ValidateFunction | null;
  raw: RawOperation;
}

const ROOT_ID = "agentfund-openapi";
const METHODS: Method[] = ["get", "post", "patch", "delete", "put"];

function rewriteRefs<T>(node: T): T {
  if (Array.isArray(node)) return node.map(rewriteRefs) as T;
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) out[k] = k === "$ref" && typeof v === "string" && v.startsWith("#/") ? ROOT_ID + v : rewriteRefs(v);
    return out as T;
  }
  return node;
}

export function formatErrors(errors: ErrorObject[] | null | undefined, prefix = ""): FieldError[] {
  return (errors ?? []).map((e) => {
    let path = `${prefix}${e.instancePath}`;
    if (e.keyword === "required") path += `/${String((e.params as { missingProperty?: string }).missingProperty)}`;
    if (e.keyword === "additionalProperties") path += `/${String((e.params as { additionalProperty?: string }).additionalProperty)}`;
    return { path: path || "/", message: e.message ?? "invalid" };
  });
}

export class OpenApiSpec {
  readonly document: RawDocument;
  readonly operations = new Map<OperationId, Operation>();
  /** Strict-typed validator set used for bodies and for response checks in tests. */
  readonly ajv: Ajv2020;
  private readonly coercing: Ajv2020;

  constructor(dir: string = SPEC_DIR) {
    this.document = parse(readFileSync(join(dir, "openapi.yaml"), "utf8")) as RawDocument;
    const root = { $id: ROOT_ID, ...rewriteRefs(this.document) };
    this.ajv = new Ajv2020({ allErrors: true, strict: false });
    this.coercing = new Ajv2020({ allErrors: true, strict: false, coerceTypes: true, useDefaults: true });
    for (const a of [this.ajv, this.coercing]) {
      addFormats(a);
      a.addSchema(root);
    }
    for (const [path, item] of Object.entries(this.document.paths)) {
      const shared = (item.parameters as RawOperation["parameters"]) ?? [];
      for (const method of METHODS) {
        const raw = item[method] as RawOperation | undefined;
        if (!raw) continue;
        const params = [...shared, ...(raw.parameters ?? [])].map((p) => this.resolveParameter(p));
        const security = raw.security ?? [];
        const bodySchema = raw.requestBody?.content?.["application/json"]?.schema;
        const op: Operation = {
          id: raw.operationId as OperationId,
          method,
          path,
          route: path.replace(/\{([^}]+)\}/g, ":$1"),
          tags: raw.tags ?? [],
          schemes: security.flatMap((s) => Object.keys(s)) as AuthScheme[],
          hasBody: Boolean(bodySchema),
          bodyRequired: Boolean(raw.requestBody?.required),
          validatePath: this.paramValidator(params.filter((p) => p.in === "path")),
          validateQuery: this.paramValidator(params.filter((p) => p.in === "query")),
          validateBody: bodySchema ? this.ajv.compile(rewriteRefs(bodySchema)) : null,
          raw,
        };
        this.operations.set(op.id, op);
      }
    }
  }

  private resolveParameter(p: RawParameter | { $ref: string }): RawParameter {
    if ("$ref" in p) {
      const name = p.$ref.split("/").pop()!;
      const found = this.document.components.parameters[name];
      if (!found) throw new Error(`unknown parameter ${p.$ref}`);
      return found;
    }
    return p;
  }

  private paramValidator(params: RawParameter[]): ValidateFunction | null {
    if (params.length === 0) return null;
    const schema = {
      type: "object",
      properties: Object.fromEntries(params.map((p) => [p.name, rewriteRefs(p.schema ?? {})])),
      required: params.filter((p) => p.required).map((p) => p.name),
    };
    return this.coercing.compile(schema);
  }

  operation(id: OperationId): Operation {
    const op = this.operations.get(id);
    if (!op) throw new Error(`operation ${id} is not in the OpenAPI document`);
    return op;
  }

  /** Validator for a named component schema, e.g. `Project`. */
  schema(name: keyof Schemas | string): ValidateFunction {
    const v = this.ajv.getSchema(`${ROOT_ID}#/components/schemas/${name}`);
    if (!v) throw new Error(`unknown schema ${name}`);
    return v;
  }

  /** Validator for the JSON (or problem+json) body of one documented response, or null when it has no body. */
  responseValidator(id: OperationId, status: number): { documented: boolean; validate: ValidateFunction | null; contentType: string | null } {
    const op = this.operation(id);
    let res = op.raw.responses[String(status)] as { $ref?: string; content?: Record<string, { schema?: Record<string, unknown> }> } | undefined;
    if (!res) return { documented: false, validate: null, contentType: null };
    if (res.$ref) res = this.document.components.responses[res.$ref.split("/").pop()!] as typeof res;
    const entry = Object.entries(res?.content ?? {})[0];
    if (!entry || !entry[1].schema) return { documented: true, validate: null, contentType: entry?.[0] ?? null };
    return { documented: true, validate: this.ajv.compile(rewriteRefs(entry[1].schema)), contentType: entry[0] };
  }
}

let cached: OpenApiSpec | undefined;
export const loadSpec = (): OpenApiSpec => (cached ??= new OpenApiSpec());
