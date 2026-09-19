export {
  PostgresTenantContextError,
  PostgresTenantScopeError,
} from "@ai-office/application/ports/project-tenant-errors.ts";
import { PostgresTenantContextError } from "@ai-office/application/ports/project-tenant-errors.ts";

export function requirePostgresTenantId(tenantId: string): string {
  if (tenantId.length === 0 || tenantId.trim() !== tenantId)
    throw new PostgresTenantContextError();
  return tenantId;
}
