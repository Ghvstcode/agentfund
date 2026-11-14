/** Members-only instances (INSTANCE_ACCESS=members): who counts as a member, and what stays open. */
import type { AppContext } from "../context.js";
import type { OperationId } from "../lib/openapi.js";
import { Problem } from "../lib/problem.js";
import type { UserRow } from "./auth.js";

/** Operations reachable without a member's credential: what sign-in needs, and signed webhooks. */
export const OPEN_OPERATIONS: ReadonlySet<OperationId> = new Set<OperationId>(["getMeta", "authGithubStart", "authGithubCallback", "ciWebhook"]);

export const membersOnly = (ctx: AppContext): boolean => ctx.config.instanceAccess === "members";

/** Whether a GitHub login belongs to one of the allowed organizations (cached by the app client). */
export async function isMemberLogin(ctx: AppContext, login: string | null | undefined): Promise<boolean> {
  if (!membersOnly(ctx)) return true;
  if (!ctx.githubApp || !login) return false;
  try {
    return await ctx.githubApp.isMember(ctx.config.allowedGithubOrgs, login);
  } catch (err) {
    // Fail closed: an unreachable GitHub must not open the instance.
    ctx.log.warn("membership check failed", { login, err });
    return false;
  }
}

export async function requireMember(ctx: AppContext, user: Pick<UserRow, "githubLogin">): Promise<void> {
  if (!(await isMemberLogin(ctx, user.githubLogin))) {
    throw new Problem("forbidden", `This instance is for members of ${ctx.config.allowedGithubOrgs.join(", ")} on GitHub.`);
  }
}
