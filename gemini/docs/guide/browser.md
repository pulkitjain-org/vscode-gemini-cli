# Browser

GeminiCode's browser is shared with your agents. Point at an element, pin notes where things should change, and let the agent check its own work in the console and network.

![A cart page open in GeminiCode's browser beside the chat, with Add to Gemini in the toolbar](../../site/media/browser-page-dark.webp)

## Let an agent open your app

Ask, for example, "open http://localhost:5173 and check the cart total". The agent opens the page in a tab beside its chat, with a **Gemini is using this page** bar, and reads the page, clicks, types, presses keys and takes screenshots while you watch. **Stop** on the bar stops the agent's turn. In Default mode it still asks before each browser action.

To open the browser yourself, click the globe in the title bar. Links to `localhost` in the terminal and the chat open in it too.

## Point at what to change

**Add to Gemini** in a page's toolbar puts the page into your prompt, for the agent using the page or else the chat in front:

- **An element.** Click the left side of the button, or press <kbd>⇧⌘C</kbd>, then click an element. A chip with its place in the page, its HTML and styles, and a picture of it joins the composer.
- **A screenshot** of the page or of an area you drag out.
- **The console** of the page.

## Leave notes on the page

**Leave Notes for Gemini** (<kbd>⌥⌘C</kbd>) lets you click elements and write a change on each, such as "make this button primary". The notes stay pinned on the page, and **Send to Gemini** on the bar sends them as one numbered list, each with its element.

![Notes pinned on elements of a page and sent to Gemini](../../site/media/showcase-notes-dark.webp "clip")

## Share a page you're signed in to

To let an agent use a page you opened yourself, such as a QA or intranet site you're signed in to, click the sparkle **Let Gemini Use This Page** in the page's toolbar and pick the agent. The agent's chat comes to the front with the page attached, so you can say what to do with it.

The agent uses the page as you, signed in, so share only pages you trust it with. While a page is shared, the composer shows a **Shared page** chip. The share lasts until you click the chip's ×, choose **Stop Sharing** on the bar, close the page or remove the agent.

The Gemini CLI's own web fetch can't reach private addresses, so for a QA or intranet site, ask Gemini to open it in the browser or share it.

## Console and network

Agents read the page's console (every level, filtered by text or level) and its requests (method, URL, status and time, or just the failed ones). They also go back, forward and reload, right-click, answer a page's alert, confirm or prompt dialog, and find the web servers already running on your Mac, so they open yours instead of starting another.

![An agent reading a page's console errors and fixing the code](../../site/media/showcase-console-dark.webp "clip")

## Which sites agents can open

- Pages on your Mac (`localhost`, `127.0.0.1`) open freely; local files follow the same rules as the agent's file tools.
- Any other site asks you first, once per agent and site, because a page can contain instructions aimed at the agent. The check uses the page's real address after every step, so a redirect or a click can't skip it.
- Turn off `gemini.browser.allowOtherSites` to keep agents to local pages, or list the only sites they may open in `gemini.browser.allowedOrigins`, such as `https://*.example.com`. You can still open any site yourself.
- Turn off `gemini.browser.enabled` to take the browser away from agents.

## Sign in once

With `gemini.browser.keepSignIns` on, agents' pages keep cookies and storage between sessions, separately for each workspace, so an agent signs in to a QA site once. They never share your own pages' storage.
