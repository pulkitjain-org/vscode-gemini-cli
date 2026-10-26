# Keyboard shortcuts

Every GeminiCode shortcut in one place. ⌘ is Command, ⌥ is Option, ⌃ is Control, ⇧ is Shift, ↩ is Return and ⌫ is Delete. On Windows and Linux, Ctrl takes the place of ⌘ (and Ctrl+Alt of ⌃⌘). VS Code's own shortcuts work as usual: the review keys stay off ⌘↩, ⌘⌫ and ⌥[ ⌥], which edit text.

Stop Agent, Focus Chat, Cycle Approval Mode and Switch Model are also in the Command Palette, under **Gemini**.

## Agents and layout

| Keys | What it does |
| --- | --- |
| <kbd>⌥⌘M</kbd> | Switch between Agents and Editor mode |
| <kbd>⌥⌘N</kbd> | New agent |
| <kbd>⇧⌘H</kbd> (outside the editor and Search) | Open Home. In the editor it is VS Code's Replace in Files; run **Gemini: Home** there |
| <kbd>⌃⌘I</kbd> | Focus the chat of the agent in front, or the last one; with no agent yet, start one |
| <kbd>↩</kbd> / <kbd>⌘↓</kbd> / <kbd>⌘⌫</kbd> (Agents pane) | Rename, open or remove the selected agent |

## Chat

| Keys | What it does |
| --- | --- |
| <kbd>↩</kbd> / <kbd>⇧↩</kbd> (chat input) | Send, or start a new line |
| <kbd>↩</kbd> (chat input, agent working) | Send now: the agent takes the message after its current step |
| <kbd>⌘↩</kbd> (chat input, agent working) | Queue the message for after the agent's turn |
| <kbd>↩</kbd> or <kbd>⌘↩</kbd> (project chat, coordinator working) | Send the message when the coordinator's turn ends |
| <kbd>↑</kbd> (empty chat input, messages queued) | Take the last queued message back to edit |
| <kbd>⌥⌘↩</kbd> (chat input, card waiting) | Allow the waiting command or edit once |
| <kbd>⌥⌘S</kbd> (chat input, card waiting) | Allow the waiting command's prefix, or the edit, for this session |
| <kbd>esc</kbd> (chat input, card waiting) | Reject the waiting card |
| <kbd>esc</kbd> <kbd>esc</kbd> (chat input, agent working) | Stop the agent |
| <kbd>⌘esc</kbd> (agent's tab; Alt+Backspace on Windows) | Stop the agent at once |
| <kbd>⌘.</kbd> (agent's tab) | Next approval mode: Default, Auto Edit, Plan, as the CLI's <kbd>⇧Tab</kbd> steps; never YOLO |
| <kbd>⌥⌘.</kbd> (agent's tab) | Switch the agent's model |
| <kbd>esc</kbd> (chat input) | Cancel Enhance prompt |
| <kbd>esc</kbd> <kbd>esc</kbd> (empty chat input) | Rewind to before one of your messages |
| <kbd>⌘N</kbd> (chat) | New chat |
| <kbd>⌘L</kbd> | Add the selection to the agent in front, or to a new agent |
| <kbd>⌥⌘E</kbd> | Enhance prompt |
| <kbd>↑</kbd> / <kbd>↓</kbd> (empty chat input) | Bring back an earlier prompt, once no message is queued |
| <kbd>⌥⌘↑</kbd> / <kbd>⌥⌘↓</kbd> (chat) | Jump to your previous or next prompt |
| <kbd>⌘B</kbd> / <kbd>⌘E</kbd> (chat input) | Make the selection bold, or code |
| <kbd>⇧⌘V</kbd> (chat input) | Switch between Write and Preview |

## Editor

| Keys | What it does |
| --- | --- |
| <kbd>⌘I</kbd> | Inline edit: say what to change in the selection |
| <kbd>⌥⌘↩</kbd> / <kbd>⇧⌥⌘⌫</kbd> | Keep or undo the agent's changes to the file you're in |
| <kbd>⌥F5</kbd> / <kbd>⇧⌥F5</kbd> | Next or previous agent change, as for any change in VS Code |

## Terminal

| Keys | What it does |
| --- | --- |
| <kbd>⌘I</kbd> (terminal) | Ask Gemini for a command, shown before it runs |

## Browser

| Keys | What it does |
| --- | --- |
| <kbd>⇧⌘C</kbd> | Add an element of the page to Gemini |
| <kbd>⌥⌘C</kbd> | Leave notes for Gemini on the page |
