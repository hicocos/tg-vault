# Global Indeterminate Spinner Design

## Goal

Replace every unknown-duration loading animation in the TG Vault frontend with one consistent SVG indeterminate spinner while preserving all real determinate progress bars.

## Component

Create `IndeterminateSpinner` with `sm`, `md`, and `lg` sizes plus `primary`, `current`, and `inverse` tones. It renders a muted circular track and a highlighted arc. The wrapper owns `role="progressbar"` and a required contextual `aria-label`; it intentionally omits `aria-valuenow` because remaining work is unknown. The SVG itself is decorative and hidden from assistive technology.

The arc rotates continuously under ordinary motion preferences. Under `prefers-reduced-motion: reduce`, rotation stops and the highlighted arc remains visible as a static busy affordance.

## Scope

Replace unknown-duration spinners in application bootstrap, lazy page fallbacks, file and task list loading, refresh/action buttons, login/setup, settings probes, notifications, upload zone, upload queue processing/resume states, bulk operations, and media preview loading/buffering.

Keep existing determinate indicators for upload percentage, byte progress, task percentage, and any other known completion values. A determinate progress bar may coexist with a small busy spinner when server-side post-processing has unknown duration.

## Visual Direction

Use the existing TG Vault monochrome/primary token system. Light surfaces use the current primary color with a low-opacity track; dark preview surfaces use white with a translucent white track. Do not add gradients, extra decoration, or new dependencies.

## Verification

Add source/component contract tests for ARIA semantics, no fake value, reduced-motion CSS, size/tone variants, and removal of legacy `animate-spin` loading indicators. Run the full frontend tests, ESLint, production build, Docker rebuild/recreate, public asset verification, responsive browser inspection, health checks, and recent error-log review.
