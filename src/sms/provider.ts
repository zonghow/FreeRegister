export interface SmsActivation {
  activationId: string;
  phoneNumber: string;
  expiresAt?: Date;
  canRequestAnotherSms?: boolean;
  activationCost?: number;
}

export interface SmsVerificationCode {
  code: string;
  source: string;
  text?: string;
  receivedAt?: Date;
  rawStatus?: unknown;
}

export interface SmsWaitForCodeOptions {
  signal?: AbortSignal;
}

export interface SmsProvider<
  Activation extends SmsActivation = SmsActivation,
  Verification extends SmsVerificationCode = SmsVerificationCode,
> {
  requestActivation(): Promise<Activation>;
  requestAnotherSms(activationId: string): Promise<string>;
  waitForVerificationCode(activationId: string, options?: SmsWaitForCodeOptions): Promise<Verification>;
  completeActivation(activationId: string): Promise<string>;
  cancelAndWithdraw(activationId: string): Promise<string>;
  cancelActivation(activationId: string): Promise<string>;
}
