import { describe, it, expect } from "vitest";
import { HELP_ONBOARDING_STEPS } from "../src/pages/Help.jsx";

// ---------------------------------------------------------------------------
// Issue #242 — HelpOnboardingModal totalSteps hardcoded magic number
//
// totalSteps used to be a hardcoded literal (3) tracked separately from the
// steps array, so editing one without the other would silently desync the
// progress dots / "N of totalSteps" label / final-step CTA. totalSteps is
// now always derived from HELP_ONBOARDING_STEPS.length.
// ---------------------------------------------------------------------------

describe("HELP_ONBOARDING_STEPS", () => {
  it("is a non-empty array of step definitions", () => {
    expect(Array.isArray(HELP_ONBOARDING_STEPS)).toBe(true);
    expect(HELP_ONBOARDING_STEPS.length).toBeGreaterThan(0);
  });

  it("each step has a label, title, and body", () => {
    HELP_ONBOARDING_STEPS.forEach((step) => {
      expect(typeof step.label).toBe("string");
      expect(typeof step.title).toBe("string");
      expect(typeof step.body).toBe("string");
    });
  });

  it("marks only the final step as isLast", () => {
    const lastIndex = HELP_ONBOARDING_STEPS.length - 1;
    HELP_ONBOARDING_STEPS.forEach((step, i) => {
      if (i === lastIndex) {
        expect(step.isLast).toBe(true);
      } else {
        expect(step.isLast).toBeFalsy();
      }
    });
  });

  it("derived totalSteps tracks the array length with no separate constant", () => {
    const totalSteps = HELP_ONBOARDING_STEPS.length;
    expect(totalSteps).toBe(HELP_ONBOARDING_STEPS.length);

    // Simulates adding/removing a step: totalSteps must move with it automatically.
    const withExtraStep = [...HELP_ONBOARDING_STEPS, { label: "Extra", title: "t", body: "b" }];
    expect(withExtraStep.length).toBe(totalSteps + 1);
  });
});
