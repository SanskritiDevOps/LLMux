import { useState } from "react";
import { Button } from "../../components/Button.jsx";
import { ConfirmDialog } from "../../components/ConfirmDialog.jsx";
import { DataTable } from "../../components/DataTable.jsx";
import { Dialog } from "../../components/Dialog.jsx";
import { EmptyState } from "../../components/EmptyState.jsx";
import { ErrorNotice } from "../../components/ErrorNotice.jsx";
import { PageHeader } from "../../components/PageHeader.jsx";
import { StatusBadge } from "../../components/StatusBadge.jsx";
import { formatDateTime, formatNumber, formatRelative } from "../../lib/format.js";
import { CreateKeyDialog } from "./CreateKeyDialog.jsx";
import { KeyForm } from "./KeyForm.jsx";
import { useKeys, useRevokeKey, useUpdateKey } from "./useKeys.js";

function EditKeyDialog({ apiKey, onClose }) {
  const update = useUpdateKey();
  const close = () => {
    update.reset();
    onClose();
  };
  return (
    <Dialog open={Boolean(apiKey)} onClose={close} title="Edit key">
      {apiKey && (
        <KeyForm
          initial={apiKey}
          submitLabel="Save"
          mutation={update}
          onSubmit={(body) => update.mutate({ id: apiKey.id, ...body }, { onSuccess: close })}
          onCancel={close}
        />
      )}
    </Dialog>
  );
}

function RevokeKeyDialog({ apiKey, onClose }) {
  const revoke = useRevokeKey();
  const close = () => {
    revoke.reset();
    onClose();
  };
  return (
    <ConfirmDialog
      open={Boolean(apiKey)}
      title="Revoke this key?"
      confirmLabel="Revoke key"
      pending={revoke.isPending}
      error={revoke.error}
      onClose={close}
      onConfirm={() => revoke.mutate(apiKey.id, { onSuccess: close })}
    >
      <p>
        Requests using <span className="font-medium text-slate-100">{apiKey?.name}</span> (
        <span className="font-mono">{apiKey?.prefix}…</span>) will be refused from now on.
      </p>
      <p>This can't be undone. Its usage history stays.</p>
    </ConfirmDialog>
  );
}

export function KeysPage() {
  const keys = useKeys();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState(null);
  const [revoking, setRevoking] = useState(null);
  const rows = keys.data?.keys ?? [];

  const columns = [
    {
      key: "name",
      header: "Name",
      render: (key) => (
        <span className="flex items-center gap-2">
          <span className="font-medium text-slate-100">{key.name}</span>
          {key.revokedAt && <StatusBadge status="revoked" label="Revoked" />}
        </span>
      ),
    },
    { key: "prefix", header: "Key", className: "font-mono text-xs", render: (k) => `${k.prefix}…` },
    {
      key: "limit",
      header: "Rate limit",
      render: (key) =>
        key.rateLimitPerMin ? `${formatNumber(key.rateLimitPerMin)} / min` : "Default",
    },
    {
      key: "lastUsed",
      header: "Last used",
      render: (key) => (
        <span title={key.lastUsedAt ? formatDateTime(key.lastUsedAt) : undefined}>
          {formatRelative(key.lastUsedAt)}
        </span>
      ),
    },
    { key: "created", header: "Created", render: (key) => formatDateTime(key.createdAt) },
    {
      key: "actions",
      header: "Actions",
      align: "right",
      render: (key) =>
        key.revokedAt ? null : (
          <span className="flex justify-end gap-1">
            <Button variant="ghost" onClick={() => setEditing(key)} aria-label={`Edit ${key.name}`}>
              Edit
            </Button>
            <Button
              variant="ghost"
              className="text-rose-300 hover:text-rose-200"
              onClick={() => setRevoking(key)}
              aria-label={`Revoke ${key.name}`}
            >
              Revoke
            </Button>
          </span>
        ),
    },
  ];

  return (
    <>
      <PageHeader
        title="API Keys"
        description="Gateway keys for your apps. Each request to /v1 needs one."
      >
        <Button onClick={() => setCreating(true)}>Create key</Button>
      </PageHeader>

      {keys.isError ? (
        <ErrorNotice error={keys.error} title="Couldn't load keys" onRetry={() => keys.refetch()} />
      ) : !keys.isPending && rows.length === 0 ? (
        <EmptyState
          title="No keys yet"
          action={<Button onClick={() => setCreating(true)}>Create your first key</Button>}
        >
          Create a key, then send it as a Bearer token with every request.
        </EmptyState>
      ) : (
        <DataTable
          caption="Gateway keys"
          columns={columns}
          rows={rows}
          rowKey={(key) => key.id}
          loading={keys.isPending}
          skeletonRows={3}
          rowClassName={(key) => (key.revokedAt ? "opacity-50" : "")}
        />
      )}

      <CreateKeyDialog open={creating} onClose={() => setCreating(false)} />
      <EditKeyDialog apiKey={editing} onClose={() => setEditing(null)} />
      <RevokeKeyDialog apiKey={revoking} onClose={() => setRevoking(null)} />
    </>
  );
}
