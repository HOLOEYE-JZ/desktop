/**
 * What the app opens with, given the policies and what the user chose before. Pure,
 * so tests can load it. The order is the policy order: anything forced, then the
 * user's choice, then a recommended server, then asking.
 */

import type { Mode } from '../shared/bridge';
import { parseInstanceUrl, type PolicySnapshot } from '../shared/policy-schema';

export interface StartChoice {
  mode?: Mode;
  instanceUrl?: string;
  /** "Change Connection" was chosen: show the choice once, also over a recommended server. */
  askConnection?: boolean;
  /** Development switches. They come after anything forced, like any other choice. */
  devInstance?: string | null;
  devStandalone?: boolean;
}

export type StartDecision =
  | { kind: 'instance'; url: string; forced: boolean; canSwitch: boolean }
  | { kind: 'standalone'; canSwitch: boolean }
  | { kind: 'welcome'; allowStandalone: boolean; instanceUrl: string | null; urlLocked: boolean; canSwitch: false }
  | { kind: 'policy-error'; policy: string; reason: string; raw?: string; canSwitch: false };

/** Direct connections are on unless a policy says otherwise; a forced server turns them off by itself. */
export function standaloneAllowed(snapshot: PolicySnapshot): boolean {
  const { AllowStandalone, InstanceUrl } = snapshot;
  if (AllowStandalone.source !== 'default') return AllowStandalone.value;
  return !(InstanceUrl.locked && InstanceUrl.value);
}

/** A problem with the policy source itself, such as an unsafe policy file. */
export interface PolicySourceProblem {
  policy: string;
  reason: string;
}

export function decideStart(snapshot: PolicySnapshot, problem: PolicySourceProblem | null, choice: StartChoice): StartDecision {
  if (problem) return { kind: 'policy-error', policy: problem.policy, reason: problem.reason, canSwitch: false };
  const { InstanceUrl, AllowInsecureInstance } = snapshot;
  if (InstanceUrl.locked && InstanceUrl.invalid) {
    return { kind: 'policy-error', policy: 'InstanceUrl', reason: InstanceUrl.invalid, raw: InstanceUrl.raw, canSwitch: false };
  }

  const allowStandalone = standaloneAllowed(snapshot);
  const forcedUrl = InstanceUrl.locked ? InstanceUrl.value : null;

  if (forcedUrl) {
    if (allowStandalone) {
      if (choice.devStandalone || choice.mode === 'standalone') return { kind: 'standalone', canSwitch: true };
      if (choice.askConnection) return { kind: 'welcome', allowStandalone: true, instanceUrl: forcedUrl, urlLocked: true, canSwitch: false };
    }
    return { kind: 'instance', url: forcedUrl, forced: true, canSwitch: allowStandalone };
  }

  const valid = (url: unknown) => {
    const parsed = parseInstanceUrl(url, AllowInsecureInstance.value);
    return parsed.ok ? parsed.value : null;
  };
  const devUrl = choice.devInstance ? valid(choice.devInstance) : null;
  if (devUrl) return { kind: 'instance', url: devUrl, forced: false, canSwitch: true };
  if (allowStandalone && (choice.devStandalone || choice.mode === 'standalone')) return { kind: 'standalone', canSwitch: true };
  if (choice.mode === 'instance') {
    const url = valid(choice.instanceUrl);
    if (url) return { kind: 'instance', url, forced: false, canSwitch: true };
  }
  if (InstanceUrl.value && !choice.askConnection) return { kind: 'instance', url: InstanceUrl.value, forced: false, canSwitch: true };
  return { kind: 'welcome', allowStandalone, instanceUrl: InstanceUrl.value, urlLocked: false, canSwitch: false };
}

/** What makes a restart worth asking for: where the app is, and what Chromium only reads at start. */
export function restartKey(decision: StartDecision, snapshot: PolicySnapshot): string {
  return JSON.stringify([
    decision.kind,
    decision.kind === 'instance' ? decision.url : null,
    decision.kind === 'policy-error' ? [decision.policy, decision.reason] : null,
    decision.canSwitch,
    decision.kind === 'welcome' ? decision.allowStandalone : null,
    snapshot.AuthServerAllowlist.value,
    snapshot.AuthNegotiateDelegateAllowlist.value,
  ]);
}
