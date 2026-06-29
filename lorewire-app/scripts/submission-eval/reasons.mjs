// Reject-reason taxonomy for user submissions (Phase 0).
// Policy: ./POLICY.md
//
// Why a fixed taxonomy instead of the model's free text: the automatic path must
// give the author a clear, non-accusatory, ACTIONABLE reason so they can fix and
// resubmit, WITHOUT leaking the exact rule that tripped (which teaches evasion).
// The model returns a category; we map it to one of these fixed messages. The raw
// model "reason" is kept only in the admin audit trail, never shown to the user.
//
// Tone rules (from the lazy-user lens, plan rule 10): address the work, never the
// person ("this story" not "you"). Say what to change. No jargon, no policy
// citations, no "violation". A rejected story feels like a rejected self here, so
// the copy has to be kind and concrete.
//
// Shape: category -> { resubmittable, en: {title, message, fix}, he: {...} }.
// `resubmittable: false` means the normal edit-and-resubmit loop is disabled
// (quarantine path, handled out of band).

export const REJECT_REASONS = {
  real_person: {
    resubmittable: true,
    en: {
      title: "Make it about you, not a named person",
      message:
        "This reads like it identifies a real, specific person. Lorewire only publishes your own story or a made-up one, so a video never puts a real third party on blast.",
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
        "This reads as an ad or a pitch rather than a real dilemma. Lorewire is for stories people vote on, not promotion.",
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
        "We could not find an actual story and a dilemma here. Lorewire needs a situation that happened (or could) and a real two-sided question.",
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
      message:
        "There is not enough here yet to build a story and a dilemma from.",
      fix: "Add a few sentences of what happened and a clear question with two sides.",
    },
    he: {
      title: "צריך קצת יותר",
      message:
        "אין כאן עדיין מספיק כדי לבנות סיפור ודילמה.",
      fix: "הוסיפו כמה משפטים על מה שקרה ושאלה ברורה עם שני צדדים.",
    },
  },

  // Shown when a human reviewer rejects a held item for a reason that does not map
  // to a sharper category above. Generic but still kind and resubmittable.
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
      message:
        "בודק.ת עברו על זה וזה לא מתאים כפי שנכתב, אבל זה קרוב.",
      fix: "חדדו את הסיפור ואת הדילמה ושלחו שוב.",
    },
  },

  // Non-discretionary path. NOT resubmittable. The user sees a neutral message; the
  // real handling (preserve, alert) happens out of band. We never echo specifics.
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
      message:
        "לא נוכל לפרסם את זה. אם לדעתכם זו טעות, פנו לתמיכה.",
      fix: "",
    },
  },
};

// Held items that are not yet rejected get an in-review message, not a reason.
export const HOLD_MESSAGE = {
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

// Map a machine category to a user-safe reason. Falls back to borderline so the
// user is never left with a blank or a raw model string.
export function reasonFor(category, lang = "en") {
  const entry = REJECT_REASONS[category] || REJECT_REASONS.borderline;
  return { ...(entry[lang] || entry.en), resubmittable: entry.resubmittable };
}
