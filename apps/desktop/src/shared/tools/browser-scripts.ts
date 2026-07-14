import type { BrowserTarget, BrowserTypeTarget, BrowserWaitTarget } from "./browser.js";

function scriptString(value: string): string {
  return JSON.stringify(value);
}

function targetScript(target: BrowserTarget): string {
  return JSON.stringify({
    ref: target.ref?.trim() || "",
    selector: target.selector?.trim() || "",
    text: target.text?.trim() || "",
  });
}

export function snapshotScript(): string {
  return `
    (() => {
      let nextRef = 1;
      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      };
      const label = (el) => {
        const aria = el.getAttribute("aria-label") || "";
        const text = (el.innerText || el.textContent || "").trim();
        const value = "value" in el ? String(el.value || "") : "";
        const placeholder = el.getAttribute("placeholder") || "";
        return (aria || text || value || placeholder || el.getAttribute("href") || el.tagName).replace(/\\s+/g, " ").slice(0, 160);
      };
      const nodes = Array.from(document.querySelectorAll("a,button,input,textarea,select,[role=button],[onclick],[tabindex]"))
        .filter(visible)
        .slice(0, 80)
        .map((el) => {
          const ref = "b" + nextRef++;
          el.setAttribute("data-ai-assistant-browser-ref", ref);
          return {
            ref,
            tag: el.tagName.toLowerCase(),
            role: el.getAttribute("role") || "",
            label: label(el),
            href: el.getAttribute("href") || "",
            type: el.getAttribute("type") || "",
          };
        });
      return JSON.stringify({
        url: location.href,
        title: document.title,
        text: document.body.innerText.replace(/\\s+/g, " ").slice(0, 4000),
        elements: nodes
      }, null, 2);
    })()
  `;
}

export function clickScript(target: BrowserTarget): string {
  return `
    (() => {
      const target = ${targetScript(target)};
      const byText = (text) => Array.from(document.querySelectorAll("a,button,[role=button],input,textarea,select,[onclick],[tabindex]"))
        .find((el) => ((el.innerText || el.textContent || el.getAttribute("aria-label") || el.getAttribute("placeholder") || "").trim()).includes(text));
      const el = target.ref
        ? document.querySelector('[data-ai-assistant-browser-ref="' + target.ref + '"]')
        : target.selector
          ? document.querySelector(target.selector)
          : target.text
            ? byText(target.text)
            : null;
      if (!el) return "ELEMENT_NOT_FOUND";
      el.scrollIntoView({ block: "center", inline: "center" });
      el.click();
      return "clicked";
    })()
  `;
}

export function typeScript(target: BrowserTypeTarget): string {
  return `
    (() => {
      const target = ${targetScript(target)};
      const value = ${scriptString(target.value)};
      const submit = ${target.submit ? "true" : "false"};
      const el = target.ref
        ? document.querySelector('[data-ai-assistant-browser-ref="' + target.ref + '"]')
        : target.selector
          ? document.querySelector(target.selector)
          : null;
      if (!el) return "ELEMENT_NOT_FOUND";
      el.scrollIntoView({ block: "center", inline: "center" });
      el.focus();
      if ("value" in el) {
        el.value = value;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      } else {
        el.textContent = value;
        el.dispatchEvent(new InputEvent("input", { bubbles: true, data: value }));
      }
      if (submit) {
        el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
        el.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true }));
      }
      return "typed";
    })()
  `;
}

export function waitScript(target: BrowserWaitTarget): string {
  return `
    (() => {
      const selector = ${scriptString(target.selector ?? "")};
      const text = ${scriptString(target.text ?? "")};
      if (selector && document.querySelector(selector)) return "yes";
      if (text && document.body.innerText.includes(text)) return "yes";
      if (!selector && !text) return "yes";
      return "no";
    })()
  `;
}

export function evaluateScript(script: string): string {
  return `
    Promise.resolve().then(async () => {
      const value = await eval(${scriptString(script)});
      if (typeof value === "string") return value;
      const json = JSON.stringify(value, null, 2);
      return json === undefined ? String(value) : json;
    }).catch((err) => "EVALUATE_ERROR: " + (err instanceof Error ? err.message : String(err)))
  `;
}

export function pageSummaryScript(): string {
  return `JSON.stringify({ url: location.href, title: document.title }, null, 2)`;
}
