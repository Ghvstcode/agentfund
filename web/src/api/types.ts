import type { components } from './schema';

type Schemas = components['schemas'];

export type Meta = Schemas['Meta'];
export type Stats = Schemas['Stats'];
export type Totals = Schemas['Totals'];
export type Project = Schemas['Project'];
export type ProjectStatus = Schemas['ProjectStatus'];
export type ProjectPreview = Schemas['ProjectPreview'];
export type Task = Schemas['Task'];
export type TaskState = Schemas['TaskState'];
export type TaskCounts = Schemas['TaskCounts'];
export type Report = Schemas['Report'];
export type Ledger = Schemas['Ledger'];
export type LedgerEntry = Schemas['LedgerEntry'];
export type DonorStanding = Schemas['DonorStanding'];
export type Donor = Schemas['Donor'];
export type AuditEvent = Schemas['Event'];
export type StreamTotals = Schemas['StreamTotals'];
export type Me = Schemas['Me'];
export type Role = Schemas['Role'];
export type ApiKey = Schemas['ApiKey'];
export type ClaimSummary = Schemas['ClaimSummary'];
export type InstanceConfig = Schemas['InstanceConfig'];
export type InstanceConfigUpdate = Schemas['InstanceConfigUpdate'];
export type Problem = Schemas['Problem'];
export type ProjectWebhook = Schemas['ProjectWebhook'];
