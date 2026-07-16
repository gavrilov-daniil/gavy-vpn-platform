import { Controller, Get, Inject } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { schema, type Database } from "@vpn/db";
import { DB } from "../db/db.module.js";
import { loadConfig } from "../config.js";

// Минимальные read-only эндпоинты под admin-SPA (M0). CRUD и auth — M1+.
@Controller("api/admin")
export class AdminController {
  private readonly cfg = loadConfig();
  constructor(@Inject(DB) private readonly db: Database) {}

  @Get("nodes")
  async nodes() {
    const rows = await this.db
      .select({ node: schema.node, server: schema.server })
      .from(schema.node)
      .leftJoin(schema.server, eq(schema.node.serverId, schema.server.id))
      .where(eq(schema.node.orgId, this.cfg.defaultOrgId));
    return rows.map(({ node, server }) => ({
      id: node.id,
      name: node.name,
      roles: node.roles,
      status: node.status,
      lastHeartbeatAt: server?.lastHeartbeatAt ?? null,
    }));
  }

  @Get("subscribers")
  async subscribers() {
    const rows = await this.db
      .select({ sub: schema.subscription, s: schema.subscriber })
      .from(schema.subscription)
      .leftJoin(schema.subscriber, eq(schema.subscription.subscriberId, schema.subscriber.id))
      .where(eq(schema.subscription.orgId, this.cfg.defaultOrgId));
    return rows.map(({ sub, s }) => ({
      id: sub.id,
      username: s?.username ?? null,
      telegramId: s?.telegramId ?? null,
      status: sub.status,
      expireAt: sub.expireAt,
      usedTrafficBytes: sub.usedTrafficBytes,
    }));
  }
}
