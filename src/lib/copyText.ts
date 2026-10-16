import { fmtRate } from './format';

/** Line a KAM pastes into chat after the client approves. Georgian, always. */
export function chatHandoff(clientId: string, rate: number): string {
  return `${clientId} ${fmtRate(rate)} გთხოვთ გაუწეროთ`;
}

/** Line a KAM sends after treasury has entered the agreed rate in the core system. Georgian, always. The client ID is the first word, so it can be copied with the line. */
export function rateBooked(clientId: string, rate: number): string {
  return `${clientId} კურსი - ${fmtRate(rate)} გაწერილია, შეგიძლიათ ჩარიცხოთ`;
}

/**
 * Message a KAM sends the client once treasury has given a rate.
 * Georgian, always. A quote does not carry an acceptance countdown.
 */
export function clientOffer(rate: number): string {
  return `თქვენი კონვერტაციისთვის, კურსი რომელიც შეგვიძლია შემოგთავაზოთ არის ${fmtRate(rate)}`;
}
