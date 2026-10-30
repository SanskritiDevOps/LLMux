import { Button } from "../../components/Button.jsx";
import { CopyField } from "../../components/CopyField.jsx";
import { Dialog } from "../../components/Dialog.jsx";
import { KeyForm } from "./KeyForm.jsx";
import { useCreateKey } from "./useKeys.js";

/**
 * Creating a key, then showing it. The full key exists in the browser only while this
 * dialog is open: it lives in the mutation result, which is dropped on close, and it is
 * never put in the query cache or anywhere else.
 */
export function CreateKeyDialog({ open, onClose }) {
  const create = useCreateKey();
  const created = create.data;

  const close = () => {
    create.reset();
    onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      closeOnBackdrop={!created}
      title={created ? "Your new key" : "Create a key"}
      footer={created && <Button onClick={close}>Done, I've saved it</Button>}
    >
      {created ? (
        <div className="space-y-4 text-sm">
          <p className="rounded-md border border-amber-400/40 bg-amber-950/30 p-3 text-amber-200">
            You won't see this key again. Copy it now and store it somewhere safe, such as your
            app's environment variables.
          </p>
          <CopyField value={created.apiKey} label={`Gateway key ${created.key.name}`} />
          <p className="text-slate-400">
            Send it as <code className="font-mono text-slate-200">Authorization: Bearer …</code> on
            every request to <code className="font-mono text-slate-200">/v1</code>.
          </p>
        </div>
      ) : (
        <KeyForm
          submitLabel="Create key"
          mutation={create}
          onSubmit={(body) =>
            create.mutate(body.rateLimitPerMin === null ? { name: body.name } : body)
          }
          onCancel={close}
        />
      )}
    </Dialog>
  );
}
