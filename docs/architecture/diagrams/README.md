# Excalidraw architecture diagrams

This directory is the durable source of truth for editable architecture diagrams.

| Diagram | File |
| --- | --- |
| System context and service boundaries | `system-context.excalidraw` |
| WeCom message lifecycle | `wecom-message-lifecycle.excalidraw` |
| Booking and handoff state machine | `booking-handoff-state-machine.excalidraw` |
| Observability data lineage | `observability-data-lineage.excalidraw` |
| Guardrail architecture | `guardrail-architecture.excalidraw` |
| Memory system architecture | `memory-system-architecture.excalidraw` |
| Evidence-first resolution and guardrail feedback loop | `evidence-first-resolution-and-guardrails.excalidraw` |
| Shareable evidence-first decision architecture | `evidence-first-decision-architecture.excalidraw` |

The first four diagrams form the system-level reading path: start with the system
boundary, follow a message through the runtime, inspect the main business state
machine, then trace how operational evidence is persisted and consumed.

## Open and edit

1. Open <https://excalidraw.com/>.
2. Choose **Open** from the main menu.
3. Select the relevant `.excalidraw` file from this directory.
4. After editing, choose **Save to...** and overwrite the same file.

The free Excalidraw web app keeps one active canvas in browser storage; it does not
provide project folders. Keep each diagram in a separate `.excalidraw` file here so
browser cache clearing or switching canvases does not lose the editable source.
