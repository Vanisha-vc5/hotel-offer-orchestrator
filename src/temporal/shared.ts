/**
 * Types and constants shared by the API, the worker and the workflow sandbox.
 * MUST stay free of Node built-ins and I/O: it is bundled into workflow code.
 */
import type {
  Decision,
  HotelOffer,
  ResultStatus,
  SupplierId,
  SupplierStatus,
  SuppliersStatus,
} from '../domain/types';
import type { Duration } from '@temporalio/common';
import { defineQuery, defineSignal } from '@temporalio/workflow';
import type { CircuitSnapshot } from '../domain/circuit';

export const TASK_QUEUE = 'hotel-offers';
export const WORKFLOW_ID_PREFIX = 'hotel-offers-';
export const STATUS_QUERY = 'status';

export function workflowIdForCity(city: string): string {
  return `${WORKFLOW_ID_PREFIX}${city}`;
}

/** Durations use Temporal's duration strings, e.g. '300ms', '4s'. */
export interface ActivityTuning {
  supplierStartToCloseTimeout: Duration;
  supplierRetry: {
    initialInterval: Duration;
    backoffCoefficient: number;
    maximumInterval: Duration;
    maximumAttempts: number;
  };
  persistStartToCloseTimeout: Duration;
  persistMaximumAttempts: number;
}

export const DEFAULT_TUNING: ActivityTuning = {
  supplierStartToCloseTimeout: '4s',
  supplierRetry: {
    initialInterval: '300ms',
    backoffCoefficient: 2,
    maximumInterval: '2s',
    maximumAttempts: 3,
  },
  persistStartToCloseTimeout: '5s',
  persistMaximumAttempts: 5,
};

export interface HotelOffersWorkflowInput {
  city: string;
  requestId: string;
  /**
   * Optional tuning, built by the API from env. Workflow code cannot read env
   * (sandbox), so configuration travels in the input and is recorded in history.
   */
  tuning?: ActivityTuning;
}

export interface HotelOffersWorkflowResult {
  offers: HotelOffer[];
  suppliersStatus: SuppliersStatus;
  resultStatus: ResultStatus;
  decisions: Decision[];
}

export type WorkflowStep = 'fetching' | 'selecting' | 'persisting' | 'done' | 'failed';

export interface WorkflowStatus {
  step: WorkflowStep;
  city: string;
  /** 'pending' until that supplier's fetch settles. */
  suppliers: Record<SupplierId, SupplierStatus | 'pending'>;
}

/** What persistOffers writes to Redis (result + provenance). */
export interface PersistPayload extends HotelOffersWorkflowResult {
  workflowId: string;
  runId: string;
  requestId: string;
}

/** Serialises supplier status as `A=up;B=down` for the X-Suppliers-Status header. */
export function formatSuppliersStatus(s: SuppliersStatus): string {
  return `A=${s.A};B=${s.B}`;
}

// ---------------------------------------------------------------------------
// Enhancement 2: supplier monitor workflows
// ---------------------------------------------------------------------------

export const MONITOR_WORKFLOW_PREFIX = 'supplier-monitor-';

export function monitorWorkflowId(supplier: SupplierId): string {
  return `${MONITOR_WORKFLOW_PREFIX}${supplier}`;
}

export interface MonitorSample {
  at: number;
  ok: boolean;
  latencyMs: number;
  status?: number;
  error?: string;
}

/** State carried across continue-as-new so history stays bounded but nothing is lost. */
export interface MonitorCarry {
  circuit: CircuitSnapshot;
  recent: MonitorSample[];
  probeCount: number;
  generation: number;
}

export interface MonitorInput {
  supplier: SupplierId;
  intervalMs: number;
  failureThreshold: number;
  cooldownMs: number;
  continueAsNewEvery: number;
  carry?: MonitorCarry;
}

export interface MonitorStats {
  supplier: SupplierId;
  circuit: CircuitSnapshot;
  recent: MonitorSample[];
  /** Total probes since the monitor was first started (survives continue-as-new). */
  probeCount: number;
  /** Probes in the current run (resets on continue-as-new). */
  iterations: number;
  /** Number of continue-as-new hops so far. */
  generation: number;
}

export const probeNowSignal = defineSignal('probeNow');
export const resetCircuitSignal = defineSignal('resetCircuit');
export const getStatsQuery = defineQuery<MonitorStats>('getStats');
