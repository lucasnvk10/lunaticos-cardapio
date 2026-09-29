import type { AuthenticatedOperator, Bindings } from "../types";
import { ApiError, createId, sha256 } from "../utils";

export async function redeemTicket(bindings: Bindings, operator: AuthenticatedOperator, rawToken: string): Promise<Record<string, unknown>> {
  if (!/^[A-Za-z0-9_-]{40,100}$/.test(rawToken ?? "")) throw new ApiError(400, "INVALID_TICKET", "QR Code inválido.");
  const tokenHash = await sha256(rawToken);
  const ticket = await bindings.DB.prepare(`
    SELECT id, event_id, product_id, product_name, status, used_at
    FROM tickets WHERE token_hash = ?
  `).bind(tokenHash).first<{
    id: string;
    event_id: string;
    product_id: string;
    product_name: string;
    status: string;
    used_at: string | null;
  }>();
  if (!ticket || ticket.event_id !== operator.eventId) throw new ApiError(404, "TICKET_NOT_FOUND", "Ficha inválida para este evento.");
  if (ticket.status === "USED") throw new ApiError(409, "TICKET_ALREADY_USED", `Ficha já utilizada${ticket.used_at ? ` em ${ticket.used_at}` : ""}.`);
  if (ticket.status !== "AVAILABLE") throw new ApiError(409, "TICKET_UNAVAILABLE", "Esta ficha foi cancelada.");
  const redeemedAt = new Date().toISOString();
  try {
    await bindings.DB.batch([
      bindings.DB.prepare(`
        UPDATE tickets SET status = 'USED', used_at = ?, used_by_operator_id = ?
        WHERE id = ? AND status = 'AVAILABLE'
      `).bind(redeemedAt, operator.id, ticket.id),
      bindings.DB.prepare(`
        INSERT INTO ticket_redemptions (id, event_id, ticket_id, product_id, operator_id, device_label, redeemed_at)
        SELECT ?, ?, id, product_id, ?, ?, ? FROM tickets
        WHERE id = ? AND status = 'USED' AND used_at = ? AND used_by_operator_id = ?
      `).bind(createId("red"), ticket.event_id, operator.id, operator.deviceLabel, redeemedAt, ticket.id, redeemedAt, operator.id)
    ]);
    const confirmed = await bindings.DB.prepare(`
      SELECT id FROM tickets WHERE id = ? AND status = 'USED' AND used_at = ? AND used_by_operator_id = ?
    `).bind(ticket.id, redeemedAt, operator.id).first<{ id: string }>();
    if (!confirmed) throw new Error("Ticket was consumed concurrently");
  } catch {
    throw new ApiError(409, "TICKET_ALREADY_USED", "Esta ficha acabou de ser utilizada em outro aparelho.");
  }
  return { status: "USED", productName: ticket.product_name, redeemedAt };
}
