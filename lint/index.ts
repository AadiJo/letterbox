// The `letterbox` oxlint plugin. .oxlintrc.json loads it through `jsPlugins`.
//
// Each rule is one correction that an agent needed once, written down so no agent
// needs it twice. Every message says what to do instead. Every rule has fixtures in
// lint/fixtures/<rule>/, and `pnpm lint:selftest` fails if a rule has none.

import type { Plugin } from '@oxlint/plugins'
import noCrossPackageRelativeImport from './rules/no-cross-package-relative-import.ts'
import noNodeInRenderer from './rules/no-node-in-renderer.ts'
import noProviderNames from './rules/no-provider-names.ts'
import noStdoutInCore from './rules/no-stdout-in-core.ts'
import rendererClock from './rules/renderer-clock.ts'
import rendererThreadLists from './rules/renderer-thread-lists.ts'
import requireSuppressionReason from './rules/require-suppression-reason.ts'
import scenarioThreadsThroughFixtures from './rules/scenario-threads-through-fixtures.ts'
import scenarioWaitsOnEvents from './rules/scenario-waits-on-events.ts'

// `satisfies` keeps the plugin name and the rule names readable for lint/selftest.ts.
export default {
  meta: { name: 'letterbox' },
  rules: {
    'no-cross-package-relative-import': noCrossPackageRelativeImport,
    'no-node-in-renderer': noNodeInRenderer,
    'no-provider-names': noProviderNames,
    'no-stdout-in-core': noStdoutInCore,
    'renderer-clock': rendererClock,
    'renderer-thread-lists': rendererThreadLists,
    'require-suppression-reason': requireSuppressionReason,
    'scenario-threads-through-fixtures': scenarioThreadsThroughFixtures,
    'scenario-waits-on-events': scenarioWaitsOnEvents,
  },
} satisfies Plugin
