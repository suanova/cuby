export {
  FINANCE_WORKFLOWS,
  buildFinancePrompt,
  financeWorkflowDisplayText,
  type FinanceWorkflowId,
} from "@memmy/local-api-contracts";

/** Only a final answer following this exact submitted request may trigger the reader. */
export function completedFinanceReviewPath(
  messages: Array<{
    id: string;
    role: string;
    content: string;
    clientRequestId?: string;
    turnId?: string;
    isStreaming?: boolean;
    stoppedByUser?: boolean;
    modelError?: unknown;
    kind?: string;
  }>,
  requestId: string,
): string | null {
  const start = messages.findIndex(
    (m) => m.role === "user" && m.clientRequestId === requestId,
  );
  if (start < 0) return null;
  const turnId = messages[start]!.turnId;
  const following = messages.slice(start + 1);
  const nextUser = following.findIndex((m) => m.role === "user");
  const answer = (nextUser < 0 ? following : following.slice(0, nextUser))
    .filter(
      (m) =>
        m.role === "assistant" &&
        (!m.kind || m.kind === "message") &&
        !m.isStreaming &&
        !m.stoppedByUser &&
        !m.modelError &&
        (!turnId || !m.turnId || m.turnId === turnId),
    )
    .at(-1);
  if (!answer) return null;
  const matches = [
    ...new Set(
      answer.content.match(
        /\boutputs\/c2-reviews\/[A-Za-z0-9_-]+\/review\.json\b/g,
      ) ?? [],
    ),
  ];
  return matches.length === 1 ? matches[0]! : null;
}
