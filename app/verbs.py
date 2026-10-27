"""Past tense of verbs: the six persons and a hint about how the form is built.

`past` is the 1st person singular as stored in `words.aorist` (έγραψα). For a few verbs
(είμαι, έχω, θέλω, ξέρω) it is the imperfect, the only past form used in everyday speech.
"""
import unicodedata

PERSONS = ["εγώ", "εσύ", "αυτός", "εμείς", "εσείς", "αυτοί"]
TONOS = "́"
VOWELS = set("αεηιουω")
DIPHTHONGS = ("αι", "ει", "οι", "ου", "υι", "αυ", "ευ")
IMPERFECT_ONLY = {"ήμουν", "είχα", "ήθελα", "ήξερα"}
# Forms the rules below get wrong; " / " separates accepted variants.
IRREGULAR = {
    "ήμουν": ["ήμουν", "ήσουν", "ήταν", "ήμασταν / ήμαστε", "ήσασταν / ήσαστε", "ήταν"],
    "ήπια": ["ήπια", "ήπιες", "ήπιε", "ήπιαμε", "ήπιατε", "ήπιαν"],
    "τάισα": ["τάισα", "τάισες", "τάισε", "ταΐσαμε", "ταΐσατε", "τάισαν"],
}
# Forms that look regular but are not built by a rule worth learning.
IRREGULAR_HINT = {"έδωσα", "παρέδωσα", "απόλαυσα", "κάθισα", "έπεσα", "παρέθεσα", "ανέπνευσα"}


def _strip(s: str) -> str:
    """Drop the stress mark but keep the diaeresis (ϊ)."""
    return unicodedata.normalize("NFC", unicodedata.normalize("NFD", s).replace(TONOS, ""))


def _stressed_index(word: str) -> int:
    """Index (in the stripped word) of the letter carrying the stress, -1 if none."""
    i = 0
    for ch in unicodedata.normalize("NFD", word):
        if ch == TONOS:
            return i - 1
        if not unicodedata.combining(ch):
            i += 1
    return -1


def _nuclei(word: str) -> list[int]:
    """Positions where the stress mark goes, one per vowel group (for αι, ου… the 2nd letter)."""
    out, i = [], 0
    while i < len(word):
        if word[i : i + 2] in DIPHTHONGS:
            out.append(i + 1)
            i += 2
        elif _strip(word[i]) in VOWELS:
            out.append(i)
            i += 1
        else:
            i += 1
    return out


def _stress(word: str, from_end: int = 3) -> str:
    """Put the stress on the n-th vowel group from the end (or the first one if the word is short)."""
    word = _strip(word)
    nuclei = _nuclei(word)
    if not nuclei:
        return word
    pos = nuclei[max(0, len(nuclei) - from_end)]
    return unicodedata.normalize("NFC", word[: pos + 1] + TONOS + word[pos + 1 :])


def _plural_base(past: str, present: str) -> str:
    """Stem for εμείς/εσείς: the stress moves right, so a stressed augment disappears.

    έγραψα -> γραψ-, ήθελα -> θελ-, μετέφρασα (μεταφράζω) -> μεταφρασ-.
    """
    bare, pres = _strip(past), _strip(present)
    stressed = _stressed_index(past)
    if (
        stressed == 0
        and bare[0] in "εη"
        and len(bare) > 1
        and bare[1] not in VOWELS
        and pres
        and pres[0] not in VOWELS
    ):
        bare = bare[1:]
    elif (
        stressed > 0
        and not bare.endswith("ηκα")
        and bare[stressed] == "ε"
        and bare[:stressed] == pres[:stressed]
        and len(pres) > stressed
        and pres[stressed] in "αιο"
    ):
        # Internal augment of a compound verb: μετ-έ-φρασα vs μετ-α-φράζω.
        bare = bare[:stressed] + pres[stressed] + bare[stressed + 1 :]
    return bare[:-1]


def conjugate(past: str, present: str) -> list[str]:
    """All six persons of the past form; the stress follows the 3rd-syllable-from-the-end rule."""
    past, present = past.strip(), present.strip()
    head, _, tail = past.partition(" ")  # "έκανα ντους": only the verb changes
    present_head = present.split(" ")[0]
    if head in IRREGULAR:
        forms = IRREGULAR[head]
    elif not head.endswith("α"):
        return []
    else:
        stem = head[:-1]
        plural = _plural_base(head, present_head)
        forms = [
            head,
            stem + "ες",
            stem + "ε",
            _stress(plural + "αμε"),
            _stress(plural + "ατε"),
            stem + "αν",
        ]
    return [f"{f} {tail}" if tail else f for f in forms]


def hint(past: str, present: str) -> str:
    """How the form is built, e.g. `-άω → -ησα`; generic advice for irregular verbs."""
    present_head = unicodedata.normalize("NFC", present.strip().split(" ")[0])
    head = _strip(past.strip().split(" ")[0])
    pres = _strip(present_head)
    contracted = present_head.endswith(("άω", "ώ"))  # μιλάω, οδηγώ
    if past.strip().split(" ")[0] in IMPERFECT_ONLY:
        return "Это имперфект: аорист у этого глагола почти не используется"
    if len(pres) <= 3 or _strip(past.strip().split(" ")[0]) in {_strip(f) for f in IRREGULAR_HINT}:
        return "Неправильный глагол — форму нужно запомнить"
    if pres.endswith("μαι") and head.endswith("ηκα"):
        return "-ομαι/-άμαι → -θηκα (пассивный аорист)"
    if contracted and head.endswith("ησα"):
        return "-άω/-ώ → -ησα"
    if contracted and head.endswith(("ασα", "εσα")):
        return f"-άω/-ώ → -{head[-3:]} (не -ησα!)"
    if contracted and head.endswith("ξα"):
        return "-άω → -ξα (не -ησα!)"
    if head.endswith("αψα") and pres.endswith("αιω"):
        return "-αίω → -αψα (καίω → έκαψα)"
    if head.endswith("ψα"):
        return "-πω/-βω/-φω/-πτω/-εύω → -ψα"
    if head.endswith("ξα") and pres.endswith(("ζω", "γω", "χω", "κω", "χνω", "σσω")):
        return "-ζω/-γω/-χω/-κω → -ξα"
    if head.endswith("σα") and pres.endswith("ζω"):
        return "-ίζω/-άζω → -σα"
    if head.endswith("ασα") and pres.endswith("ανω"):
        return "-άνω → -ασα (χάνω → έχασα)"
    if head.endswith("σα") and pres.endswith("νω"):
        return "-ώνω/-ήνω/-ύνω → -σα"
    if head.endswith("σα"):
        return "-ω → -σα"
    if head.endswith("ηκα"):
        return "Неправильный: -ηκα (μπήκα, βγήκα, βρήκα)"
    return "Неправильный глагол — форму нужно запомнить"
