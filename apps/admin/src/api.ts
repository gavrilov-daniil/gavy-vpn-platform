const BASE = "/api";

async function request<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

export interface Node {
  id: string;
  name: string;
  roles: string[];
  status: string;
  last_heartbeat_at: string | null;
}

export interface Subscriber {
  id: string;
  username: string | null;
  telegram_id: string | null;
  status: string;
  expire_at: string | null;
  used_traffic_bytes: number;
}

export function getNodes(): Promise<Node[]> {
  return request<Node[]>("/admin/nodes");
}

export function getSubscribers(): Promise<Subscriber[]> {
  return request<Subscriber[]>("/admin/subscribers");
}
