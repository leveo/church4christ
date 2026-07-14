import { validateManifest, validateProviderResources } from '../manifest.mjs';
import { resolveProvider } from '../resolve-provider.mjs';
import { result } from '../readiness.mjs';
import { redact } from '../redact.mjs';

export async function checkManifest(options) {
  if (!options || !options.catalog || typeof options.catalog !== 'object') throw new TypeError('manifest check catalog is required');
  if (options.readManifest !== undefined && typeof options.readManifest !== 'function') throw new TypeError('readManifest must be a function');
  const secrets = options.secrets ?? [];
  let raw;
  try {
    raw = options.manifest ?? await options.readManifest?.();
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      return [result('manifest.missing', 'error', 'church.config.json is missing.', 'Run setup to create the installation manifest.')];
    }
    return redact([result('manifest.invalid', 'error', 'The installation manifest could not be read.', 'Restore church.config.json or rerun setup.')], secrets);
  }
  if (raw === undefined || raw === null) {
    return [result('manifest.missing', 'error', 'church.config.json is missing.', 'Run setup to create the installation manifest.')];
  }
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const manifest = validateManifest(parsed, options.catalog);
    validateProviderResources(manifest.resources, manifest.database, { requireBindingIds: true });
    const resolved = resolveProvider(manifest.modules, manifest.database, options.catalog);
    if (resolved.backend !== manifest.database || resolved.modules.length !== manifest.modules.length ||
        resolved.modules.some((key) => !manifest.modules.includes(key))) {
      throw new Error('manifest modules do not contain their canonical dependencies');
    }
    return [result('manifest.ok', 'info', 'The installation manifest is valid.', 'No action is required.')];
  } catch {
    return redact([result('manifest.invalid', 'error', 'church.config.json is invalid or inconsistent with the capability catalog.', 'Rerun setup to regenerate a canonical manifest.')], secrets);
  }
}
