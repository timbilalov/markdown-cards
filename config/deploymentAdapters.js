/** @typedef {Record<string, string | undefined>} BuildEnvironment */
/** @typedef {{
 *   detect: (environment: BuildEnvironment) => boolean;
 *   create: () => import('@sveltejs/kit').Adapter;
 * }} DeploymentPlatform */
import netlify from '@sveltejs/adapter-netlify';
import vercel from '@sveltejs/adapter-vercel';

/** @type {Record<string, DeploymentPlatform>} */
export const PLATFORMS = {
  vercel: {
    detect: environment => environment.VERCEL === '1',
    create: () => vercel()
  },
  netlify: {
    detect: environment => environment.NETLIFY === 'true',
    create: () => netlify({ edge: false })
  }
};

/**
 * Selects a platform from DEPLOY_TARGET, platform metadata or the Vercel default.
 *
 * @param {BuildEnvironment} [environment=process.env] Build environment to inspect.
 * @returns {string} The selected key in PLATFORMS.
 *
 * @example
 * resolveDeploymentTarget({ DEPLOY_TARGET: 'netlify' }); // 'netlify'
 */
export function resolveDeploymentTarget(environment = process.env) {
  const explicitTarget = environment.DEPLOY_TARGET;
  if (explicitTarget !== undefined) {
    if (!Object.hasOwn(PLATFORMS, explicitTarget)) {
      throw new Error(`Unknown DEPLOY_TARGET "${explicitTarget}". Supported targets: ${Object.keys(PLATFORMS).join(', ')}.`);
    }
    return explicitTarget;
  }

  const detected = Object.entries(PLATFORMS)
    .filter(([, platform]) => platform.detect(environment))
    .map(([target]) => target);
  if (detected.length > 1) {
    throw new Error(`Multiple deployment platforms detected: ${detected.join(', ')}. Set DEPLOY_TARGET explicitly.`);
  }

  // Preserve existing local builds and deployments without platform metadata.
  return detected[0] ?? 'vercel';
}

/**
 * Creates the SvelteKit adapter for the selected deployment platform.
 *
 * @param {BuildEnvironment} [environment=process.env] Build environment to inspect.
 * @returns {import('@sveltejs/kit').Adapter} The platform's configured adapter.
 *
 * @example
 * const adapter = createDeploymentAdapter({ DEPLOY_TARGET: 'vercel' });
 * // adapter.name === '@sveltejs/adapter-vercel'
 */
export function createDeploymentAdapter(environment = process.env) {
  return PLATFORMS[resolveDeploymentTarget(environment)].create();
}
