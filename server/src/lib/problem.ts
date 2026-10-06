/** RFC 9457 problems with the stable codes of protocol.md §11. */
export type ProblemCode =
  | "unauthorized"
  | "forbidden"
  | "banned"
  | "not-found"
  | "validation"
  | "task-not-open"
  | "dependencies-unmet"
  | "project-not-active"
  | "claim-limit"
  | "project-task-cap"
  | "project-daily-cap"
  | "claim-not-active"
  | "already-reported"
  | "slug-taken"
  | "repo-already-registered"
  | "repo-unverifiable"
  | "bad-signature"
  | "rate-limited"
  | "internal";

const DEFAULTS: Record<ProblemCode, { status: number; title: string }> = {
  unauthorized: { status: 401, title: "Authentication required" },
  forbidden: { status: 403, title: "Forbidden" },
  banned: { status: 403, title: "Account banned" },
  "not-found": { status: 404, title: "Not found" },
  validation: { status: 422, title: "Validation failed" },
  "task-not-open": { status: 409, title: "Task is not open" },
  "dependencies-unmet": { status: 409, title: "Task dependencies are not merged" },
  "project-not-active": { status: 409, title: "Project is not active" },
  "claim-limit": { status: 409, title: "Active claim limit reached" },
  "project-task-cap": { status: 409, title: "Task exceeds the new-project per-task cap" },
  "project-daily-cap": { status: 409, title: "New-project daily cap reached" },
  "claim-not-active": { status: 409, title: "Claim is not active" },
  "already-reported": { status: 409, title: "Claim already reported" },
  "slug-taken": { status: 409, title: "Slug is taken" },
  "repo-already-registered": { status: 409, title: "Repository is already registered" },
  "repo-unverifiable": { status: 422, title: "Repository could not be verified" },
  "bad-signature": { status: 401, title: "Bad webhook signature" },
  "rate-limited": { status: 429, title: "Too many requests" },
  internal: { status: 500, title: "Internal error" },
};

export interface FieldError {
  path: string;
  message: string;
}

export class Problem extends Error {
  readonly code: ProblemCode;
  readonly status: number;
  readonly title: string;
  readonly detail: string | undefined;
  readonly errors: FieldError[] | undefined;
  readonly headers: Record<string, string>;

  constructor(code: ProblemCode, detail?: string, opts: { errors?: FieldError[]; status?: number; headers?: Record<string, string> } = {}) {
    super(detail ?? DEFAULTS[code].title);
    this.code = code;
    this.status = opts.status ?? DEFAULTS[code].status;
    this.title = DEFAULTS[code].title;
    this.detail = detail;
    this.errors = opts.errors;
    this.headers = opts.headers ?? {};
  }

  toJSON(baseUrl: string, instance?: string): Record<string, unknown> {
    return {
      type: `${baseUrl}/problems/${this.code}`,
      title: this.title,
      status: this.status,
      ...(this.detail ? { detail: this.detail } : {}),
      ...(instance ? { instance } : {}),
      ...(this.errors ? { errors: this.errors } : {}),
    };
  }
}

export const PROBLEM_CODES = Object.keys(DEFAULTS) as ProblemCode[];
export const problemInfo = (code: ProblemCode) => DEFAULTS[code];
export const validation = (path: string, message: string): Problem => new Problem("validation", message, { errors: [{ path, message }] });
