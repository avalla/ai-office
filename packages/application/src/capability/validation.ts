import type {
  CapabilityGrant,
  ConnectorDescriptor,
  Resource,
  ResourceType,
} from "@ai-office/domain/capability/capability.ts";
import { getConnectorDescriptor } from "@ai-office/domain/capability/capability.ts";
import { normalizeCanonicalJson } from "@ai-office/domain/capability/canonical-json.ts";
import {
  CapabilityValidationError,
  UnsupportedConnectorProviderError,
  UnsupportedConnectorResourceTypeError,
} from "@ai-office/domain/capability/errors.ts";
import { validateFakeConnectorConstraints } from "@ai-office/domain/capability/fake-connector-policy.ts";

export const resourceTypes: readonly ResourceType[] = [
  "filesystem_scope",
  "github_repository",
  "sqlite_database",
  "shell_environment",
];

export function requiredText(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized.length === 0)
    throw new CapabilityValidationError(`${field} cannot be empty`);
  return normalized;
}

export function canonicalRecord(
  value: Readonly<Record<string, unknown>>,
  field: string,
): Readonly<Record<string, unknown>> {
  const normalized = normalizeCanonicalJson(value);
  if (
    normalized === null ||
    Array.isArray(normalized) ||
    typeof normalized !== "object"
  )
    throw new CapabilityValidationError(`${field} must be an object`);
  assertNoSensitiveFields(normalized, field);
  return normalized as Readonly<Record<string, unknown>>;
}

const sensitiveConfigurationKeys = new Set([
  "apikey",
  "authorization",
  "credential",
  "credentialref",
  "credentials",
  "password",
  "secret",
  "token",
]);

function assertNoSensitiveFields(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      assertNoSensitiveFields(item, `${path}[${index}]`),
    );
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, item] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
    if (sensitiveConfigurationKeys.has(normalizedKey))
      throw new CapabilityValidationError(
        `${path} cannot contain sensitive field ${key}`,
      );
    assertNoSensitiveFields(item, `${path}.${key}`);
  }
}

export function validateResource(resource: Resource): void {
  requiredText(resource.id, "resource id");
  requiredText(resource.projectId, "project id");
  requiredText(resource.provider, "provider");
  requiredText(resource.displayName, "display name");
  if (!resourceTypes.includes(resource.type))
    throw new CapabilityValidationError("invalid resource type");
  connectorDescriptorForResource(resource);
  canonicalRecord(resource.configuration, "resource configuration");
}

export function connectorDescriptorForResource(
  resource: Pick<Resource, "provider" | "type">,
): ConnectorDescriptor {
  const descriptor = getConnectorDescriptor(resource.provider);
  if (descriptor === null)
    throw new UnsupportedConnectorProviderError(resource.provider);
  if (!descriptor.resourceTypes.includes(resource.type))
    throw new UnsupportedConnectorResourceTypeError(
      descriptor.id,
      resource.type,
    );
  return descriptor;
}

export function validateGrant(grant: CapabilityGrant, provider: string): void {
  for (const [value, field] of [
    [grant.id, "grant id"],
    [grant.projectId, "project id"],
    [grant.principalId, "principal id"],
    [grant.resourceId, "resource id"],
    [grant.grantedBy, "granted by"],
    [grant.reason, "reason"],
  ] as const)
    requiredText(value, field);
  if (grant.actions.length === 0)
    throw new CapabilityValidationError("at least one action is required");
  if (!Number.isFinite(grant.validFrom.getTime()))
    throw new CapabilityValidationError("grant validFrom must be a valid date");
  if (
    grant.expiresAt !== undefined &&
    !Number.isFinite(grant.expiresAt.getTime())
  )
    throw new CapabilityValidationError("grant expiresAt must be a valid date");
  const descriptor = getConnectorDescriptor(provider);
  if (descriptor === null)
    throw new UnsupportedConnectorProviderError(provider);
  const supported = new Set(
    descriptor.operations.map((operation) => operation.operation),
  );
  for (const action of grant.actions) {
    if (action !== `${descriptor.id}.*` && !supported.has(action))
      throw new CapabilityValidationError(
        `unsupported or unsafe action pattern: ${action}`,
      );
  }
  if (
    grant.expiresAt !== undefined &&
    grant.expiresAt.getTime() <= grant.validFrom.getTime()
  )
    throw new CapabilityValidationError("grant expiry must be after validFrom");
  validateFakeConnectorConstraints(grant.constraints);
}
