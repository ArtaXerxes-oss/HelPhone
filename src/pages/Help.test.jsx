import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  ExplorerLink,
  HelpOnboardingModal,
  privateRequestLabel,
  txExplorerUrl,
} from "./Help";

describe("Help explorer helpers", () => {
  it("rejects malformed hashes and trims valid hashes", () => {
    expect(txExplorerUrl(null)).toBeNull();
    expect(txExplorerUrl({ hash: "abc" })).toBeNull();
    expect(txExplorerUrl("not-a-hash")).toBeNull();
    expect(txExplorerUrl(`  ${"a".repeat(64)}  `)).toBe(
      `https://stellar.expert/explorer/testnet/tx/${"a".repeat(64)}`,
    );
  });

  it("uses safe fallbacks for malformed labels and request ids", () => {
    expect(privateRequestLabel({ id: 4 })).toBe("Private request #pending");
    expect(privateRequestLabel(0)).toBe("Private request #pending");
    expect(privateRequestLabel(42)).toBe("Private request #42");

    render(<ExplorerLink hash={"b".repeat(64)} label={null} />);
    expect(
      screen.getByRole("link", { name: /view transaction/i }),
    ).toHaveAttribute("rel", "noopener noreferrer");
  });
});

describe("HelpOnboardingModal", () => {
  it("closes on Escape and removes its document listener", () => {
    const onClose = vi.fn();
    const removeSpy = vi.spyOn(document, "removeEventListener");
    const { unmount } = render(
      <HelpOnboardingModal
        open
        onClose={onClose}
        onConnectWallet={vi.fn()}
      />,
    );

    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveFocus();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();

    unmount();
    expect(removeSpy).toHaveBeenCalledWith("keydown", expect.any(Function));
  });
});
