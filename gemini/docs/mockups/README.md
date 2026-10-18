# IDE mockups

The eight screens the agentic plan describes, drawn as HTML pages in the GeminiCode Dark theme. Open any `.dc.html` file in a browser; `ide.css` holds the shared chrome and theme values, and `canvas.json` lays the boards out side by side. The plan's mockups table (`../AGENTIC-PLAN.md`, section 0) says which screen goes with which section.

| File | Screen |
| --- | --- |
| `Main.dc.html` | Home: my work |
| `MergePanel.dc.html` | Merge request panel with the merge checklist |
| `ConfirmCard.dc.html` | Confirm-class permission card |
| `AuditLog.dc.html` | Audit log |
| `Restart.dc.html` | After a restart: unfinished work |
| `Trace.dc.html` | Latency readout and Record Performance Trace |
| `Connections.dc.html` | Connections: the five tools and the team's MCP servers |
| `Checks.dc.html` | Checks on any branch |

The side cards with a question for a heading ("What it proves", "What asks, what doesn't") explain the screen to a reader. They are not part of the app.

The colours are the GeminiCode Dark theme's own values and the font is the system UI font, so a screen built in the app should look the same as its mockup. When a screen in the app and its mockup differ, the mockup is the target until the plan says otherwise.
