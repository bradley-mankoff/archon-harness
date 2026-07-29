const badgeScript = `(() => {
  const badgeByName = new Map();
  const badgeClass = "archon-harness-workflow-badge";

  function capture(payload) {
    for (const item of payload?.workflows ?? []) {
      const workflow = item?.workflow ?? {};
      const providers = [workflow.provider, ...(workflow.nodes ?? []).map((node) => node?.provider)];
      let badge = null;
      if (workflow.name === "archon-efficient-pi") badge = "Pi modular";
      else if (workflow.name === "archon-efficient" || workflow.name === "archon-efficient-omp") badge = "OMP harness";
      else if (providers.includes("claude")) badge = "Claude required";
      else if (item?.source === "bundled" && !workflow.provider) badge = "Inherited provider";
      if (badge) badgeByName.set(workflow.name, badge);
    }
    decorate();
  }

  function decorate() {
    for (const option of document.querySelectorAll('[role="option"]')) {
      const name = option.querySelector("div > span")?.textContent?.trim();
      const badge = name ? badgeByName.get(name) : null;
      const current = option.querySelector("." + badgeClass);
      if (!badge) {
        current?.remove();
        continue;
      }
      if (current?.textContent === badge) continue;
      current?.remove();
      const chip = document.createElement("span");
      chip.className = badgeClass;
      chip.textContent = badge;
      chip.setAttribute("aria-label", badge);
      const source = option.querySelector(":scope > span");
      option.insertBefore(chip, source);
    }
  }

  const originalFetch = window.fetch.bind(window);
  window.fetch = async (...args) => {
    const response = await originalFetch(...args);
    try {
      const input = args[0];
      const url = new URL(input instanceof Request ? input.url : String(input), window.location.origin);
      if (url.pathname === "/api/workflows" && response.ok) {
        response.clone().json().then(capture).catch(() => {});
      }
    } catch {}
    return response;
  };

  new MutationObserver(decorate).observe(document.documentElement, { childList: true, subtree: true });
})();`;

const badgeStyle = `<style id="archon-harness-badge-style">
.archon-harness-workflow-badge {
  flex: none;
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 1px 6px;
  color: var(--text-secondary);
  background: var(--surface);
  font: 600 9px/1.4 "JetBrains Mono", monospace;
  letter-spacing: .04em;
  white-space: nowrap;
}
</style>`;

export function workflowBadgeScript(): string {
  return badgeScript;
}

export function injectWorkflowBadges(html: string): string {
  if (html.includes("archon-harness-badges.js")) return html;
  const injection = `${badgeStyle}<script defer src="/__archon-harness-badges.js"></script>`;
  return html.replace("<head>", `<head>${injection}`);
}
