import { fmtRate, fmtTime } from './format';

/** Line a KAM pastes into chat after the client approves. Georgian, always. */
export function chatHandoff(clientId: string, rate: number): string {
  return `${clientId} ${fmtRate(rate)} გთხოვთ გაუწეროთ`;
}

/** Line a KAM sends after treasury has entered the agreed rate in the core system. Georgian, always. */
export function rateBooked(rate: number): string {
  return `კურსი - ${fmtRate(rate)} გაწერილია, შეგიძლიათ ჩარიცხოთ`;
}

/**
 * Message a KAM sends the client once treasury has given a rate.
 * Georgian, always. The validity clock is omitted when treasury did not set one.
 */
export function clientOffer(rate: number, validUntil: string | null | undefined): string {
  const offer = `თქვენი კონვერტაციისთვის, კურსი რომელიც შეგვიძლია შემოგთავაზოთ არის ${fmtRate(rate)}`;
  const time = fmtTime(validUntil);
  if (!time) return offer;
  return `${offer} კურსი ვალიდურია ${time}`;
}
