import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CANVAS_LIVE_EVENTS_JWKS_URL } from '../../../src/lib/learningCanvasLiveEvents';
import { CANVAS_REQUIRED_SCOPES } from '../../../src/lib/learningCanvasProvider';
import { GOOGLE_CLASSROOM_SCOPES } from '../../../src/lib/learningGoogleAuth';

const read = (path: string): string => readFileSync(path, 'utf8');
const packageMetadata = JSON.parse(read('package.json')) as { version: string; private: boolean };
const lockMetadata = JSON.parse(read('package-lock.json')) as {
  version: string;
  packages: Record<string, { version?: string }>;
};
const changelog = read('CHANGELOG.md');
const readme = read('README.md');
const learning = read('docs/features/learning.md');
const deploy = read('docs/deploy.md');
const upgrade = read('docs/upgrade.md');
const release = read('docs/release-process.md');
const security = read('SECURITY.md');
const readiness = read('docs/features/onboarding-readiness.md');
const devVars = read('.dev.vars.example');
const cloudflareSetup = read('docs/cloudflare-setup.md');
const readinessCatalog = JSON.parse(read('config/readiness.json')) as {
  checks: Array<Record<string, unknown>>;
};
const capabilitiesCatalog = JSON.parse(read('config/capabilities.json')) as {
  order: string[];
  capabilities: Record<string, { requiresBackend?: string }>;
};
const keyRotationSection = deploy.slice(
  deploy.indexOf('### Learning module and shared credential key ring'),
  deploy.indexOf('### Google Classroom OAuth and optional Pub/Sub'),
);
const googleRunbook = deploy.slice(
  deploy.indexOf('### Google Classroom OAuth and optional Pub/Sub'),
  deploy.indexOf('### Canvas OAuth and signed Live Events'),
);
const syncBudgetSection = deploy.slice(deploy.indexOf('Manual sync is an authenticated'), deploy.indexOf('## 3. Create the database tables'));
const retentionSection = learning.slice(learning.indexOf('## Retention, deletion'), learning.indexOf('## Canvas provenance'));

describe('v1.1.0 Learning release contract', () => {
  it('keeps private package metadata at exactly 1.1.0 and preserves 1.0.0 history', () => {
    expect(packageMetadata).toMatchObject({ version: '1.1.0', private: true });
    expect(lockMetadata.version).toBe('1.1.0');
    expect(lockMetadata.packages['']?.version).toBe('1.1.0');
    expect(readme).toMatch(/current (?:source )?release[^\n]*1\.1\.0/i);
    expect(readme).toMatch(/1\.0\.0[^\n]*initial open-source release/i);
    expect(changelog.indexOf('## [Unreleased]')).toBeLessThan(changelog.indexOf('## [1.1.0] - 2026-08-18'));
  });

  it('records the complete dated Learning release without collapsing privacy boundaries', () => {
    const section = changelog.slice(
      changelog.indexOf('## [1.1.0] - 2026-08-18'),
      changelog.indexOf('## [1.0.0] - 2026-08-12'),
    );
    for (const marker of [
      'Google Classroom', 'Canvas', 'learner', 'sync', 'Activity Score', 'Genesis',
      'gpt-image-2', '0017', '0026', 'Instructure, Inc.', 'AGPL',
    ]) expect(section, marker).toContain(marker);
    expect(section).toMatch(/grades[^\n]*(not|never)|not[^\n]*grades/i);
    expect(section).toMatch(/answers[^\n]*(not|never)|not[^\n]*answers/i);
    expect(section).toMatch(/provider[^\n]*authoritative/i);
  });

  it('documents the exact Google consent, callback, minimal scopes, and authenticated Pub/Sub topology', () => {
    expect(deploy).toContain('/admin/learning/google/callback');
    expect(deploy).toMatch(/OAuth consent screen/i);
    expect(deploy).toMatch(/GOOGLE_CLASSROOM_CLIENT_ID[\s\S]{0,220}GOOGLE_CLASSROOM_CLIENT_SECRET/);
    for (const scope of GOOGLE_CLASSROOM_SCOPES) expect(deploy, scope).toContain(scope);
    for (const binding of [
      'GOOGLE_CLASSROOM_PUBSUB_TOPIC',
      'GOOGLE_PUBSUB_SERVICE_ACCOUNT_EMAIL',
      'GOOGLE_PUBSUB_SUBSCRIPTION_NAME',
    ]) {
      expect(deploy, binding).toContain(binding);
      expect(devVars, binding).toContain(binding);
    }
    expect(deploy).toContain('classroom-notifications@system.gserviceaccount.com');
    expect(deploy).toContain('/api/learning/google/pubsub');
    expect(deploy).toMatch(/OIDC[\s\S]{0,240}(audience|aud)/i);
    expect(deploy).toMatch(/registration[^\n]*(week|renew)/i);
    expect(deploy).toMatch(/disconnect[\s\S]{0,260}(registrations\.delete|registration)[\s\S]{0,260}revok/i);
    expect(deploy).toMatch(/domain-wide delegation[^\n]*(not|unsupported)/i);
  });

  it('documents the exact Canvas origin, OAuth scope, signed-event, and cleanup boundaries', () => {
    for (const binding of [
      'CANVAS_ALLOWED_ORIGINS', 'CANVAS_OAUTH_CLIENT_ID', 'CANVAS_OAUTH_CLIENT_SECRET',
    ]) expect(deploy, binding).toContain(binding);
    expect(deploy).toContain('/admin/learning/canvas/callback');
    for (const scope of CANVAS_REQUIRED_SCOPES) expect(deploy, scope).toContain(scope);
    expect(deploy).toContain('/api/learning/canvas/live-events');
    expect(deploy).toContain(CANVAS_LIVE_EVENTS_JWKS_URL);
    expect(deploy).toMatch(/signed[^\n]*(JWT|compact)/i);
    expect(deploy).toMatch(/0024_learning_canvas_cleanup_saga\.sql/);
    expect(deploy).toMatch(/disconnect[\s\S]{0,320}(local disable|disabled)[\s\S]{0,320}(retry|cleanup)/i);
  });

  it('documents key rotation, all sync triggers, cron partitioning, and Free-plan budgets', () => {
    expect(deploy).toMatch(/LEARNING_CREDENTIAL_KEYS[\s\S]{0,260}rotation/i);
    expect(deploy).toMatch(/add[^\n]*(new|next)[^\n]*key[\s\S]{0,260}currentVersion/i);
    expect(deploy).toMatch(/do not remove[^\n]*(old|previous)[^\n]*key/i);
    expect(deploy).toMatch(/manual[\s\S]{0,180}scheduled[\s\S]{0,180}notification/i);
    expect(deploy).toContain('15,45 * * * *');
    expect(deploy).toMatch(/:15[^\n]*(cleanup|registration)/i);
    expect(deploy).toMatch(/:45[^\n]*(reconciliation|sync)/i);
    expect(deploy).toMatch(/D1 Free[^\n]*50 (?:queries|query)/i);
    expect(deploy).toMatch(/50[^\n]*(provider|external)?[^\n]*subrequests|subrequests[^\n]*50/i);
  });

  it('locks the forward migration and matched-recovery order for 1.0 to 1.1', () => {
    const d1 = readdirSync('migrations').filter((name) => /^00(?:1[7-9]|2[0-6])_/.test(name)).sort();
    const postgres = readdirSync('migrations-supabase').filter((name) => /^00(?:1[7-9]|2[0-6])_/.test(name)).sort();
    expect(d1).toHaveLength(10);
    expect(postgres).toEqual(d1);
    for (const name of d1) {
      expect(upgrade, name).toContain(name);
      expect(deploy, name).toContain(name);
    }
    expect(upgrade).toMatch(/1\.0(?:\.0)?[^\n]*(?:to|→)[^\n]*1\.1\.0/i);
    expect(upgrade).toMatch(/staging[\s\S]{0,300}(backup|restore)[\s\S]{0,300}(doctor|readiness)/i);
    expect(upgrade).toMatch(/do not roll back code alone|matched (?:database )?(?:backup|restore)/i);
  });

  it('states honest retention, readiness, demo, and Canvas derivative operations', () => {
    expect(learning).toMatch(/no automatic[^\n]*(retention|TTL)|retention[^\n]*operator policy/i);
    expect(learning).toMatch(/Person deletion/i);
    expect(security).toMatch(/Learning[\s\S]{0,500}(credential|token)[\s\S]{0,500}(retention|deletion)/i);
    expect(readiness).toMatch(/Learning[\s\S]{0,500}(OAuth|provider)[\s\S]{0,500}(doctor|readiness)/i);
    expect(learning).toMatch(/fictional local Canvas snapshot/i);
    expect(learning).toContain('.example.test');
    expect(learning).toMatch(/PostgreSQL[\s\S]{0,180}Redis[\s\S]{0,180}(background|job|worker)/i);
    expect(learning).toMatch(/backup[\s\S]{0,220}restore/i);
    expect(learning).toContain('https://github.com/instructure/canvas-lms');
    expect(learning).toContain('https://github.com/leveo/canvas-lms');
    expect(learning).toContain('1c9f0bb8013ed69c4f2efe11fd483025469b7e6c');
    expect(learning).toContain('57c5ad2505cf69c95faead538995fc59c6c38fe8');
    expect(learning).toContain(
      'https://github.com/leveo/canvas-lms/blob/57c5ad2505cf69c95faead538995fc59c6c38fe8/CHURCH4CHRIST_NOTICE.md',
    );
    expect(learning).toMatch(/Instructure, Inc\./);
    expect(learning).toMatch(/AGPL v3/i);
    expect(learning).toMatch(/not affiliated[^\n]*(sponsored|endorsed)/i);
    expect(learning).toMatch(/upstream update/i);
    expect(learning).toMatch(/corresponding source/i);
  });

  it('updates the maintainer process for 1.1.0 without creating a release automatically', () => {
    expect(release).toMatch(/v1\.1\.0/);
    expect(release).toMatch(/npm version 1\.1\.0 --no-git-tag-version/);
    expect(release).toMatch(/0017[\s\S]{0,160}0026/);
    expect(release).toMatch(/no release is created|does not authorize/i);
    expect(release).toMatch(/do not (?:push|create)[^\n]*(?:tag|release)|never[^\n]*force-push/i);
  });

  it('adds Learning to the canonical bilingual manual-readiness checklist', () => {
    const check = readinessCatalog.checks.find((entry) => entry.id === 'learning-provider-operations');
    expect(check).toMatchObject({
      category: 'operations',
      severity: 'warning',
      selectors: { capabilities: ['learning'], services: [] },
      surfaces: ['admin'],
      adminPath: '/admin/learning',
      manualVersion: 1,
      legacyCodes: [],
      title: { en: expect.any(String), zh: expect.any(String) },
      description: { en: expect.any(String), zh: expect.any(String) },
      remediation: { en: expect.any(String), zh: expect.any(String) },
    });
    expect(JSON.stringify(check)).toMatch(/OAuth|provider/i);
    expect(JSON.stringify(check)).toMatch(/Canvas|Live Events/i);
    expect(JSON.stringify(check)).toMatch(/Google|Pub\/Sub/i);
    expect(JSON.stringify(check)).toMatch(/保留|删除|retention|deletion/i);
  });

  it('keeps the Cloudflare operator guide tied to the canonical D1-capable count', () => {
    const d1Capable = capabilitiesCatalog.order.filter(
      (key) => capabilitiesCatalog.capabilities[key]?.requiresBackend !== 'supabase',
    );
    expect(d1Capable).toHaveLength(18);
    expect(cloudflareSetup).toContain(`default for ${d1Capable.length} modules`);
  });

  it('gives a complete, non-destructive Learning key-rotation inventory and stale-state procedure', () => {
    for (const table of [
      'learning_provider_credentials',
      'learning_google_oauth_states',
      'learning_canvas_oauth_states',
      'learning_canvas_cleanup_tasks',
    ]) {
      expect(keyRotationSection, table).toMatch(
        new RegExp(`SELECT key_version, COUNT\\(\\*\\) AS envelope_count\\s+FROM ${table}`, 'i'),
      );
    }
    expect(keyRotationSection).toMatch(/expir(?:y|ation)[^\n]*(does not|never)[^\n]*delet/i);
    expect(keyRotationSection).toMatch(/replacement OAuth[\s\S]{0,220}supersed/i);
    expect(keyRotationSection).toMatch(/DELETE FROM learning_google_oauth_states[\s\S]{0,260}claim_marker IS NULL/i);
    expect(keyRotationSection).toMatch(/DELETE FROM learning_canvas_oauth_states[\s\S]{0,260}claim_marker IS NULL/i);
  });

  it('describes the actual Google disconnect credential and retained-state lifecycle', () => {
    expect(googleRunbook).not.toMatch(/disconnect[^\n]*removes the active encrypted envelope/i);
    expect(googleRunbook).toMatch(/disconnect[\s\S]{0,420}disabled[^\n]*active use[\s\S]{0,420}learning_provider_credentials/i);
    expect(googleRunbook).toMatch(/finaliz[\s\S]{0,220}deletes?[^\n]*encrypted credential/i);
    expect(retentionSection).toMatch(/Google OAuth state[\s\S]{0,220}notification\s+receipts?[\s\S]{0,220}retention/i);
  });

  it('distinguishes production trigger caps from provider-library hard maxima', () => {
    expect(syncBudgetSection).toMatch(
      /manual[^\n]*scheduled[^\n]*Google Pub\/Sub[^\n]*Canvas Live Events[\s\S]{0,260}21 Google[^\n]*10 Canvas/i,
    );
    expect(syncBudgetSection).toMatch(/47[^\n]*Google[\s\S]{0,180}23[^\n]*Canvas[\s\S]{0,220}(library|internal)[^\n]*hard max/i);
  });

  it('names the complete normalized activity-event retention shape', () => {
    expect(retentionSection).toMatch(/activity events retain[\s\S]{0,220}provider[^\n]*event type/i);
    expect(retentionSection).toMatch(/Person[\s\S]{0,180}identity[\s\S]{0,180}enrollment[\s\S]{0,180}course[\s\S]{0,180}activity/i);
    expect(retentionSection).toMatch(/occurrence[^\n]*ingestion[^\n]*timestamps/i);
  });

  it('keeps release prose natural instead of satisfying a case-sensitive test artifact', () => {
    expect(release).toMatch(/boundary froze\s+files\s+`0001`/i);
    expect(release).not.toMatch(/boundary froze\s+Files/);
  });
});
