// User-safe rejection reasons for submissions (Phase 2). The app copy of the
// taxonomy validated in Phase 0 (scripts/submission-eval/reasons.mjs); ported to
// TS so the submission flow and the dashboard can import it.
//
// Why a fixed taxonomy instead of the model's free text: the author gets a clear,
// non-accusatory, ACTIONABLE reason so they can fix and resubmit, WITHOUT leaking
// the exact rule that tripped (which teaches evasion). The pipeline produces a
// machine `category`; we map it to one of these fixed messages. The raw model
// reason is kept only in the audit trail (submission_events / reject_reason), never
// shown verbatim. Tone: address the work, never the person; say what to change; no
// jargon, no "violation". Both EN and HE, shown in the submission's own language.

export type ReasonLang = "en" | "he";

interface ReasonText {
  title: string;
  message: string;
  fix: string;
}

interface RejectReason {
  resubmittable: boolean;
  en: ReasonText;
  he: ReasonText;
}

// The keys the dashboard + audit use. `quarantine` is the non-discretionary path
// (not resubmittable, handled out of band).
export type ReasonKey =
  | "real_person"
  | "spam"
  | "hate"
  | "sexual"
  | "off_policy"
  | "low_effort"
  | "borderline"
  | "quarantine";

export const REJECT_REASONS: Record<ReasonKey, RejectReason> = {
  real_person: {
    resubmittable: true,
    en: {
      title: "Make it about you, not a named person",
      message:
        "This reads like it identifies a real, specific person. LoreWire only publishes your own story or a made-up one, so a video never puts a real third party on blast.",
      fix: "Remove names, handles, workplaces, and any detail that points to one real person, or tell it as your own experience.",
    },
    he: {
      title: "ספרו על עצמכם, לא על אדם מזוהה",
      message:
        "הסיפור הזה מזהה אדם אמיתי וספציפי. לורווייר מפרסמת רק את הסיפור שלכם או סיפור בדיוני, כדי שסרטון לעולם לא יחשוף אדם שלישי אמיתי.",
      fix: "הסירו שמות, כינויים, מקומות עבודה וכל פרט שמצביע על אדם אמיתי אחד, או ספרו זאת כחוויה האישית שלכם.",
    },
  },
  spam: {
    resubmittable: true,
    en: {
      title: "Looks like promotion",
      message:
        "This reads as an ad or a pitch rather than a real dilemma. LoreWire is for stories people vote on, not promotion.",
      fix: "Drop the links and product or channel mentions and tell the actual story behind the dilemma.",
    },
    he: {
      title: "נראה כמו קידום",
      message:
        "זה נקרא כמו פרסומת או קידום ולא כדילמה אמיתית. לורווייר היא לסיפורים שמצביעים עליהם, לא לקידום.",
      fix: "הסירו קישורים ואזכורים של מוצר או ערוץ, וספרו את הסיפור האמיתי שמאחורי הדילמה.",
    },
  },
  hate: {
    resubmittable: true,
    en: {
      title: "Take out the attack",
      message:
        "This includes a slur or an attack on a person or group. Strong feelings and blunt language are fine; targeting people is not.",
      fix: "Rewrite without the slur or the attack and keep the focus on the situation and the choice.",
    },
    he: {
      title: "הסירו את ההתקפה",
      message:
        "יש כאן כינוי גנאי או התקפה על אדם או קבוצה. רגשות חזקים ושפה ישירה זה בסדר; פגיעה באנשים לא.",
      fix: "כתבו מחדש בלי הגנאי או ההתקפה, והשאירו את המיקוד במצב ובהחלטה.",
    },
  },
  sexual: {
    resubmittable: true,
    en: {
      title: "Keep it non-explicit",
      message:
        "This is too sexually explicit to turn into a published video. The dilemma can still touch on relationships without explicit detail.",
      fix: "Tell the same situation without the explicit content.",
    },
    he: {
      title: "בלי תוכן מיני מפורש",
      message:
        "התוכן מיני ומפורש מדי מכדי להפוך לסרטון שמתפרסם. הדילמה עדיין יכולה לגעת במערכות יחסים בלי פירוט מפורש.",
      fix: "ספרו את אותו מצב בלי התוכן המפורש.",
    },
  },
  off_policy: {
    resubmittable: true,
    en: {
      title: "Tell a story with a real choice",
      message:
        "We could not find an actual story and a dilemma here. LoreWire needs a situation that happened (or could) and a real two-sided question.",
      fix: "Add what happened and end with a genuine question people could land on either side of.",
    },
    he: {
      title: "ספרו סיפור עם התלבטות אמיתית",
      message:
        "לא מצאנו כאן סיפור ממשי ודילמה. לורווייר צריכה מצב שקרה (או יכול לקרות) ושאלה אמיתית עם שני צדדים.",
      fix: "הוסיפו מה קרה, וסיימו בשאלה אמיתית שאפשר להצדיק כל אחד מצדדיה.",
    },
  },
  low_effort: {
    resubmittable: true,
    en: {
      title: "A bit more to go on",
      message: "There is not enough here yet to build a story and a dilemma from.",
      fix: "Add a few sentences of what happened and a clear question with two sides.",
    },
    he: {
      title: "צריך קצת יותר",
      message: "אין כאן עדיין מספיק כדי לבנות סיפור ודילמה.",
      fix: "הוסיפו כמה משפטים על מה שקרה ושאלה ברורה עם שני צדדים.",
    },
  },
  borderline: {
    resubmittable: true,
    en: {
      title: "Not quite ready",
      message:
        "A reviewer looked at this and it is not a fit as written, but it is close.",
      fix: "Tighten the story and the dilemma and send it back in.",
    },
    he: {
      title: "כמעט מוכן",
      message: "בודק.ת עברו על זה וזה לא מתאים כפי שנכתב, אבל זה קרוב.",
      fix: "חדדו את הסיפור ואת הדילמה ושלחו שוב.",
    },
  },
  quarantine: {
    resubmittable: false,
    en: {
      title: "This submission can't be accepted",
      message:
        "We can't publish this one. If you think this was a mistake, contact support.",
      fix: "",
    },
    he: {
      title: "לא ניתן לקבל את ההגשה הזו",
      message: "לא נוכל לפרסם את זה. אם לדעתכם זו טעות, פנו לתמיכה.",
      fix: "",
    },
  },
};

export const HOLD_MESSAGE: Record<ReasonLang, { title: string; message: string }> = {
  en: {
    title: "In review",
    message:
      "Thanks. A person is taking a quick look before this goes live. You'll see it update here.",
  },
  he: {
    title: "בבדיקה",
    message:
      "תודה. מישהו עובר על זה במהירות לפני שזה עולה לאוויר. תראו כאן עדכון.",
  },
};

// Map a pipeline machine category (judge or Tier 1) to a reason key. The judge
// categories map mostly 1:1; ambiguous/clean never reject so they fall back to
// borderline if they somehow reach here. Tier 1 OpenAI categories are folded in.
export function categoryToReasonKey(category: string | null | undefined): ReasonKey {
  switch (category) {
    case "real_person":
    case "real_person_ambiguous":
      return "real_person";
    case "spam":
    case "illicit":
    case "illicit/violent":
      return "spam";
    case "hate":
    case "harassment":
    case "harassment/threatening":
    case "hate/threatening":
    case "violence":
      return "hate";
    case "sexual":
      return "sexual";
    case "off_policy":
      return "off_policy";
    case "low_effort":
      return "low_effort";
    case "threat_self_harm":
    case "self-harm":
    case "self-harm/intent":
    case "sexual/minors":
    case "quarantine":
      return "quarantine";
    default:
      return "borderline";
  }
}

/** The user-safe reason for a rejected submission, in its own language. */
export function resolveReason(
  category: string | null | undefined,
  lang: string,
): ReasonText & { key: ReasonKey; resubmittable: boolean } {
  const key = categoryToReasonKey(category);
  const entry = REJECT_REASONS[key];
  const text = lang === "he" ? entry.he : entry.en;
  return { ...text, key, resubmittable: entry.resubmittable };
}

// The "Other" path lets a reviewer write the rejection note themselves when the
// fixed taxonomy doesn't fit. Such a reject carries the sentinel category
// `custom` and stores the note in reject_reason; unlike the AI/audit reason, this
// note is authored to be shown, so the dashboard renders it verbatim. Cap it to a
// sentence or two so it stays in line with the taxonomy messages.
export const CUSTOM_REASON_CATEGORY = "custom";
export const CUSTOM_REASON_MAX = 500;

/** Frame a reviewer's free-text rejection note the same friendly way as the
 *  taxonomy reasons. The note itself is shown verbatim; only the title and the
 *  call to action are canned. */
export function customReason(message: string, lang: string): ReasonText {
  const he = lang === "he";
  return {
    title: he ? "הערה מהבודק/ת שלנו" : "A note from our reviewer",
    message,
    fix: he
      ? "בצעו את השינוי הזה ושלחו שוב."
      : "Make that change and send it back in.",
  };
}
