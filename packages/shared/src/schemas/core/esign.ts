// E-signature payloads (rule 8). Every action that needs a signature takes `signature` in its body;
// actions that need a second person (QA witness, QA countersign) also take `witness`.
import { z } from 'zod';
import { SignatureMeaning } from '../../enums';

export const ESignRequest = z.object({
  password: z.string().min(1, 'Password is required').max(200),
  meaning: z.enum(SignatureMeaning),
  reason: z.string().trim().min(3, 'Give a reason (at least 3 characters)').max(500),
});
export type ESignRequest = z.infer<typeof ESignRequest>;

/** A second person signs at the same terminal with their own username and password. */
export const WitnessSignRequest = ESignRequest.extend({
  username: z.string().trim().min(1).max(40),
});
export type WitnessSignRequest = z.infer<typeof WitnessSignRequest>;
