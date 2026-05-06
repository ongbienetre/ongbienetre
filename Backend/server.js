require("dotenv").config();
const express    = require("express");
const multer     = require("multer");
const cors       = require("cors");
const rateLimit  = require("express-rate-limit");
const helmet     = require("helmet");
const sanitizeHtml = require("sanitize-html");
const fs         = require("fs");
const path       = require("path");
const PDFDocument= require("pdfkit");
const nodemailer = require("nodemailer");
const fetch      = require("node-fetch");
const { Pool }   = require("pg");

const app    = express();
const PORT   = process.env.PORT || 3000;
const IS_PROD= process.env.NODE_ENV === "production";

// ═══════════════════════════════════════════════════════════════════════════════
// SÉCURITÉ
// ═══════════════════════════════════════════════════════════════════════════════

// 1. Helmet — en-têtes HTTP sécurisés (XSS, MIME sniffing, clickjacking…)
app.use(helmet({ contentSecurityPolicy: false }));

// 2. CORS restrictif — uniquement les origines autorisées
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "https://ongbien-etre.org,http://localhost:3000").split(",");
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    cb(new Error(`CORS bloqué : ${origin}`));
  },
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));

// 3. Rate limiting global (100 req / 15 min par IP)
app.use("/api/", rateLimit({
  windowMs: 15 * 60 * 1000, max: 100,
  message: { success: false, message: "Trop de requêtes. Réessayez dans 15 minutes." },
  standardHeaders: true, legacyHeaders: false,
}));

// 4. Rate limiting strict sur les formulaires (10 envois / heure)
const formLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 10,
  message: { success: false, message: "Limite d'envoi atteinte. Réessayez dans 1 heure." },
});

// 5. Parsing avec limite de taille
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true, limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

// ─── Multer sécurisé ──────────────────────────────────────────────────────────
const ALLOWED_MIME = ["image/jpeg", "image/png", "image/webp", "application/pdf"];

const secureStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, "uploads");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, "");
    cb(null, `up_${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`);
  },
});

const upload = multer({
  storage: secureStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_MIME.includes(file.mimetype)) return cb(null, true);
    cb(new Error(`Type de fichier non autorisé : ${file.mimetype}`));
  },
});

// ─── PostgreSQL ───────────────────────────────────────────────────────────────
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// ─── Helpers ──────────────────────────────────────────────────────────────────
function createTransporter() {
  return nodemailer.createTransport({ service: "gmail", auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS } });
}
const ONG_EMAIL = process.env.ONG_EMAIL || "ongbienetre349@gmail.com";

function sanitize(v) {
  if (typeof v !== "string") return "";
  return sanitizeHtml(v.trim(), { allowedTags: [], allowedAttributes: {} });
}

function isValidEmail(e) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e); }

function cleanupFile(p) { if (p && fs.existsSync(p)) try { fs.unlinkSync(p); } catch {} }

async function getNextNumero() {
  const r = await pool.query("SELECT nextval('adherent_seq')");
  return "M-" + String(r.rows[0].nextval).padStart(4, "0");
}

function buildEmail(title, color, body) {
  return `<div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;border:1px solid #e0e0e0;border-radius:8px;overflow:hidden">
    <div style="background:${color};padding:20px;text-align:center"><h2 style="color:#fff;margin:0">${title}</h2></div>
    <div style="padding:24px">${body}</div>
    <div style="background:#f8f9fb;padding:12px;text-align:center;font-size:12px;color:#888">ONG Bien-être — Ahoué-Abidjan, Côte d'Ivoire</div>
  </div>`;
}

// ─── Auth admin ───────────────────────────────────────────────────────────────
function requireAdmin(req, res, next) {
  const token = (req.headers["authorization"] || "").split(" ")[1];
  if (!process.env.ADMIN_PASSWORD || token !== process.env.ADMIN_PASSWORD)
    return res.status(401).json({ success: false, message: "Non autorisé." });
  next();
}

// Route de vérification de login admin (pas d'erreur de sécurité : ne retourne que success/fail)
app.post("/api/admin/login", rateLimit({ windowMs: 15*60*1000, max: 10, message: { success: false, message: "Trop de tentatives." } }), (req, res) => {
  const { password } = req.body;
  if (!password || !process.env.ADMIN_PASSWORD || password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ success: false, message: "Mot de passe incorrect." });
  }
  res.json({ success: true });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ROUTE — Contact
// ═══════════════════════════════════════════════════════════════════════════════
app.post("/api/contact", formLimiter, async (req, res) => {
  try {
    const nom      = sanitize(req.body.nom);
    const email    = sanitize(req.body.email);
    const telephone= sanitize(req.body.telephone);
    const message  = sanitize(req.body.message);

    if (!nom || !email || !message) return res.status(400).json({ success: false, message: "Champs obligatoires manquants." });
    if (!isValidEmail(email)) return res.status(400).json({ success: false, message: "Email invalide." });
    if (message.length > 2000) return res.status(400).json({ success: false, message: "Message trop long." });

    const t = createTransporter();
    await t.sendMail({ from: process.env.EMAIL_USER, to: ONG_EMAIL, replyTo: email,
      subject: `📩 Nouveau contact — ${nom}`,
      html: buildEmail("ONG Bien-être — Nouveau contact", "#004aad", `
        <p><strong>Nom :</strong> ${nom}</p>
        <p><strong>Email :</strong> ${email}</p>
        <p><strong>Téléphone :</strong> ${telephone || "—"}</p>
        <hr style="border:none;border-top:1px solid #eee;margin:16px 0">
        <p><strong>Message :</strong></p>
        <p style="background:#f8f9fb;padding:12px;border-radius:6px;white-space:pre-wrap">${message}</p>`) });

    await t.sendMail({ from: process.env.EMAIL_USER, to: email,
      subject: "Votre message a bien été reçu — ONG Bien-être",
      html: buildEmail("ONG Bien-être", "#004aad", `
        <p>Bonjour <strong>${nom}</strong>,</p>
        <p>Nous avons bien reçu votre message et vous répondrons dans les plus brefs délais.</p>
        <p style="margin-top:24px">Cordialement,<br><strong>L'équipe ONG Bien-être</strong></p>`) });

    res.json({ success: true, message: "Message envoyé." });
  } catch (err) {
    console.error("❌ /api/contact :", err.message);
    res.status(500).json({ success: false, message: "Erreur serveur." });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// ROUTE — Don / Partenaire / Bénévole
// ═══════════════════════════════════════════════════════════════════════════════
app.post("/api/unified", formLimiter, async (req, res) => {
  try {
    const nom      = sanitize(req.body.nom);
    const email    = sanitize(req.body.email);
    const telephone= sanitize(req.body.telephone);
    const type     = sanitize(req.body.type);
    const message  = sanitize(req.body.message);

    if (!nom || !email || !type) return res.status(400).json({ success: false, message: "Champs manquants." });
    if (!isValidEmail(email)) return res.status(400).json({ success: false, message: "Email invalide." });
    if (!["don","partenaire","benevole"].includes(type)) return res.status(400).json({ success: false, message: "Type invalide." });

    const labels = { don: "Faire un don", partenaire: "Devenir partenaire", benevole: "Devenir bénévole" };
    let details = "";
    if (type === "don") {
      const mode = sanitize(req.body.don_mode);
      details = mode === "argent"
        ? `<p><strong>Don en argent :</strong> ${sanitize(req.body.don_amount) || "—"} XOF</p>`
        : `<p><strong>Don en nature :</strong> ${sanitize(req.body.in_kind_description) || "—"}</p><p><strong>Mode :</strong> ${sanitize(req.body.in_kind_delivery) || "—"}</p>`;
    } else if (type === "partenaire") {
      details = `<p><strong>Organisation :</strong> ${sanitize(req.body.partner_org) || "—"}</p><p><strong>Objet :</strong> ${sanitize(req.body.partner_msg) || "—"}</p>`;
    } else {
      details = `<p><strong>Disponibilités :</strong> ${sanitize(req.body.vol_availability) || "—"}</p><p><strong>Compétences :</strong> ${sanitize(req.body.vol_skills) || "—"}</p>`;
    }

    const t = createTransporter();
    await t.sendMail({ from: process.env.EMAIL_USER, to: ONG_EMAIL, replyTo: email,
      subject: `📬 ${labels[type]} — ${nom}`,
      html: buildEmail(`ONG Bien-être — ${labels[type]}`, "#28a745", `
        <p><strong>Nom :</strong> ${nom}</p><p><strong>Email :</strong> ${email}</p><p><strong>Tél :</strong> ${telephone || "—"}</p>
        <hr style="border:none;border-top:1px solid #eee;margin:16px 0">${details}
        ${message ? `<p><strong>Message :</strong></p><p style="background:#f8f9fb;padding:12px;border-radius:6px;white-space:pre-wrap">${message}</p>` : ""}`) });

    await t.sendMail({ from: process.env.EMAIL_USER, to: email,
      subject: "Votre demande a bien été reçue — ONG Bien-être",
      html: buildEmail("ONG Bien-être", "#28a745", `
        <p>Bonjour <strong>${nom}</strong>,</p>
        <p>Votre demande <strong>${labels[type]}</strong> a bien été reçue. Notre équipe vous contactera prochainement.</p>
        <p style="margin-top:24px">Cordialement,<br><strong>L'équipe ONG Bien-être</strong></p>`) });

    res.json({ success: true, message: "Demande envoyée." });
  } catch (err) {
    console.error("❌ /api/unified :", err.message);
    res.status(500).json({ success: false, message: "Erreur serveur." });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// ROUTE — Réinsertion
// ═══════════════════════════════════════════════════════════════════════════════
app.post("/api/reinsertion", formLimiter, async (req, res) => {
  try {
    const nom    = sanitize(req.body.nom);
    const prenom = sanitize(req.body.prenom);
    const tel    = sanitize(req.body.telephone);
    const email  = sanitize(req.body.email);
    const ville  = sanitize(req.body.ville);

    if (!nom || !prenom || !tel || !ville) return res.status(400).json({ success: false, message: "Champs obligatoires manquants." });
    if (email && !isValidEmail(email)) return res.status(400).json({ success: false, message: "Email invalide." });

    const fields = ["age","sexe","adresse","nationalite","matrimonial","etudes","situation","competences"];
    const d = {};
    fields.forEach(f => d[f] = sanitize(req.body[f]));

    const t = createTransporter();
    await t.sendMail({ from: process.env.EMAIL_USER, to: ONG_EMAIL, replyTo: email || undefined,
      subject: `📂 Réinsertion — ${nom} ${prenom}`,
      html: buildEmail("ONG Bien-être — Réinsertion", "#004aad", `
        <p><strong>Nom :</strong> ${nom}</p><p><strong>Prénom :</strong> ${prenom}</p>
        <p><strong>Âge :</strong> ${d.age || "—"}</p><p><strong>Sexe :</strong> ${d.sexe || "—"}</p>
        <p><strong>Téléphone :</strong> ${tel}</p><p><strong>Email :</strong> ${email || "—"}</p>
        <p><strong>Adresse :</strong> ${d.adresse || "—"}</p><p><strong>Ville :</strong> ${ville}</p>
        <p><strong>Nationalité :</strong> ${d.nationalite || "—"}</p>
        <hr style="border:none;border-top:1px solid #eee;margin:16px 0">
        <p><strong>Situation matrimoniale :</strong> ${d.matrimonial || "—"}</p>
        <p><strong>Niveau d'études :</strong> ${d.etudes || "—"}</p>
        <p><strong>Situation actuelle :</strong> ${d.situation || "—"}</p>
        <p><strong>Compétences / Domaine :</strong></p>
        <p style="background:#f8f9fb;padding:12px;border-radius:6px;white-space:pre-wrap">${d.competences || "—"}</p>`) });

    if (email) await t.sendMail({ from: process.env.EMAIL_USER, to: email,
      subject: "Votre demande de réinsertion a été reçue — ONG Bien-être",
      html: buildEmail("ONG Bien-être", "#004aad", `
        <p>Bonjour <strong>${prenom} ${nom}</strong>,</p>
        <p>Nous avons bien reçu votre dossier de réinsertion et vous contacterons très prochainement.</p>
        <p style="margin-top:24px">Cordialement,<br><strong>L'équipe ONG Bien-être</strong></p>`) });

    res.json({ success: true, message: "Demande envoyée." });
  } catch (err) {
    console.error("❌ /api/reinsertion :", err.message);
    res.status(500).json({ success: false, message: "Erreur serveur." });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// ROUTE — Adhésion (individu + entreprise) avec CinetPay + montant exact
// ═══════════════════════════════════════════════════════════════════════════════
app.post("/api/membership", formLimiter, upload.single("photo"), async (req, res) => {
  const uploadedFile = req.file?.path || null;
  try {
    const numero     = await getNextNumero();
    const memberType = sanitize(req.body.memberType) || "individual";
    const isEnt      = memberType === "enterprise";
    const tel        = sanitize(req.body.tel);
    const email      = sanitize(req.body.email);
    const pays       = sanitize(req.body.pays);
    const ville      = sanitize(req.body.ville);
    const motivation = sanitize(req.body.motivation);
    const sexe       = sanitize(req.body.sexe);
    const piece      = sanitize(req.body.piece);
    const num_piece  = sanitize(req.body.numero_piece);
    const payCotis   = req.body.payCotisation === "true";

    // Montant : toujours envoyé depuis le front (déjà calculé), on le vérifie côté serveur
    const montantRecu = parseInt(req.body.montant, 10) || 0;
    const fraisAdh    = isEnt ? 10000 : 5000;
    const cotisation  = isEnt ? 60000 : 24000;
    const montant     = fraisAdh + (payCotis ? cotisation : 0);
    // Vérification anti-manipulation : si le montant reçu ne correspond pas, on ignore et on utilise le calcul serveur
    if (montantRecu !== montant) console.warn(`⚠️ Montant incohérent — reçu: ${montantRecu}, calculé: ${montant}`);

    if (!tel || !email || !ville || !pays) return res.status(400).json({ success: false, message: "Champs obligatoires manquants." });
    if (!isValidEmail(email)) return res.status(400).json({ success: false, message: "Email invalide." });

    let data, champsPdf, nomAffiche;

    if (isEnt) {
      const ent_nom   = sanitize(req.body.entreprise_nom);
      const forme     = sanitize(req.body.forme_juridique);
      const rccm      = sanitize(req.body.rccm);
      const secteur   = sanitize(req.body.secteur);
      const siege     = sanitize(req.body.adresse_siege);
      const rep_nom   = sanitize(req.body.representant_nom);
      const rep_fn    = sanitize(req.body.representant_fonction);
      if (!ent_nom || !rccm || !rep_nom) return res.status(400).json({ success: false, message: "Informations entreprise obligatoires." });
      nomAffiche = ent_nom;
      data = { numero, memberType, ent_nom, forme, rccm, secteur, siege, pays, ville, tel, email, sexe, piece, num_piece, rep_nom, rep_fn, motivation, montant, payCotis, photoPath: uploadedFile };
      champsPdf = [["Type","Entreprise/Société"],["Raison sociale",ent_nom],["Forme juridique",forme],["RCCM",rccm],["Secteur",secteur],["Siège",siege],["Représentant",rep_nom],["Fonction",rep_fn],["Pièce",`${piece} — ${num_piece}`],["Email",email],["Tél",tel],["Ville/Pays",`${ville}, ${pays}`],["Cotisation annuelle",payCotis?"✅ Oui":"❌ Non"],["Montant total",`${montant.toLocaleString()} XOF`]];
    } else {
      const nom    = sanitize(req.body.nom);
      const prenoms= sanitize(req.body.prenoms);
      const naiss  = sanitize(req.body.naissance);
      const lieu   = sanitize(req.body.lieu);
      const prof   = sanitize(req.body.profession);
      const nat    = sanitize(req.body.nationalite);
      const niv    = sanitize(req.body.niveau);
      if (!nom || !prenoms) return res.status(400).json({ success: false, message: "Nom et prénoms obligatoires." });
      nomAffiche = `${nom} ${prenoms}`;
      data = { numero, memberType, nom, prenoms, naiss, lieu, piece, num_piece, pays, ville, tel, email, prof, sexe, nat, niv, motivation, montant, payCotis, photoPath: uploadedFile };
      champsPdf = [["Type","Particulier/Association"],["Nom",nom],["Prénoms",prenoms],["Naissance",naiss],["Lieu naiss.",lieu],["Sexe",sexe],["Nationalité",nat],["Profession",prof],["Pièce",`${piece} — ${num_piece}`],["Email",email],["Tél",tel],["Ville/Pays",`${ville}, ${pays}`],["Niveau d'étude",niv],["Cotisation annuelle",payCotis?"✅ Oui":"❌ Non"],["Montant total",`${montant.toLocaleString()} XOF`]];
    }

    // Sauvegarde JSON
    const dir = path.join(__dirname, "adherents");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${numero}.json`), JSON.stringify(data, null, 2));

    // Génération PDF
    const pdfPath = path.join(dir, `${numero}.pdf`);
    const pdfStream = fs.createWriteStream(pdfPath);
    const doc = new PDFDocument();
    doc.pipe(pdfStream);
    doc.font("Times-Bold").fontSize(16).fillColor("#004aad")
       .text("ADHÉSION — ONG Bien-être", { align: "center" }).moveDown(0.3)
       .font("Times-Roman").fontSize(12).fillColor("black")
       .text(`N° ${numero} — ${new Date().toLocaleDateString("fr-FR")}`, { align: "center" }).moveDown(0.8);
    champsPdf.forEach(([l, v]) => doc.font("Helvetica-Bold").fontSize(10).text(`${l} : `, { continued: true }).font("Helvetica").text(v || "—"));
    if (uploadedFile && !uploadedFile.endsWith(".pdf")) {
      try { doc.addPage().image(uploadedFile, { fit: [280, 280], align: "center" }); } catch {}
    }
    doc.end();

    // CinetPay — montant calculé côté serveur, pas côté client
    let paymentUrl = process.env.CINETPAY_CHECKOUT_URL || null;
    try {
      const cpRes = await fetch("https://api-checkout.cinetpay.com/v2/payment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          site_id: process.env.CINETPAY_SITE_ID,
          api_key: process.env.CINETPAY_API_KEY,
          transaction_id: numero,
          amount: montant,
          currency: "XOF",
          description: `Adhésion ONG Bien-être — ${isEnt ? "Entreprise" : "Particulier"} — ${nomAffiche}`,
          return_url: process.env.CINETPAY_RETURN_URL || "https://ongbien-etre.org/#donate",
          cancel_url: process.env.CINETPAY_CANCEL_URL || "https://ongbien-etre.org/#donate",
          customer_name: nomAffiche,
          customer_email: email,
          customer_phone_number: tel,
          metadata: JSON.stringify({ numero, memberType, montant }),
        }),
      });
      const cpData = await cpRes.json();
      if (cpData.code === "201") paymentUrl = cpData.data.payment_url;
      else console.warn("⚠️ CinetPay :", cpData.message || cpData.code);
    } catch (cpErr) {
      console.error("❌ CinetPay :", cpErr.message);
    }

    // Emails après PDF
    pdfStream.on("finish", async () => {
      try {
        const t = createTransporter();
        const bodyOng = isEnt
          ? `<p><strong>N° :</strong> ${numero}</p><p><strong>Entreprise :</strong> ${data.ent_nom} (${data.forme})</p><p><strong>RCCM :</strong> ${data.rccm}</p><p><strong>Représentant :</strong> ${data.rep_nom} — ${data.rep_fn}</p><p><strong>Email :</strong> ${email}</p><p><strong>Montant :</strong> <strong style="color:#1a9e5c">${montant.toLocaleString()} XOF</strong></p>`
          : `<p><strong>N° :</strong> ${numero}</p><p><strong>Nom :</strong> ${data.nom} ${data.prenoms}</p><p><strong>Email :</strong> ${email}</p><p><strong>Montant :</strong> <strong style="color:#1a9e5c">${montant.toLocaleString()} XOF</strong></p>`;

        await t.sendMail({ from: process.env.EMAIL_USER, to: [ONG_EMAIL, process.env.EMAIL_USER],
          subject: `🆕 Adhésion ${isEnt?"Entreprise":"Particulier"} : ${numero} — ${nomAffiche}`,
          html: buildEmail("ONG Bien-être — Nouvelle adhésion", "#004aad", bodyOng),
          attachments: [{ filename: `${numero}.pdf`, path: pdfPath }, ...(uploadedFile ? [{ filename: "document_joint", path: uploadedFile }] : [])] });

        if (email) await t.sendMail({ from: process.env.EMAIL_USER, to: email,
          subject: `Votre adhésion — N° ${numero}`,
          html: buildEmail("Bienvenue à l'ONG Bien-être !", "#1a9e5c", `
            <p>Bonjour <strong>${nomAffiche}</strong>,</p>
            <p>Votre dossier d'adhésion a bien été reçu.</p>
            <p><strong>N° d'adhérent :</strong> <span style="font-size:20px;color:#004aad;font-weight:bold">${numero}</span></p>
            <p><strong>Montant à régler :</strong> <span style="font-size:18px;color:#1a9e5c;font-weight:bold">${montant.toLocaleString()} XOF</span></p>
            <p>Notre équipe validera votre dossier et vous contactera prochainement.</p>
            <p style="margin-top:24px">Cordialement,<br><strong>L'équipe ONG Bien-être</strong></p>`) });
      } catch (e) { console.error("❌ Email adhésion :", e.message); }
    });

    res.json({ success: true, numero, paymentUrl, montant });
  } catch (err) {
    if (uploadedFile) cleanupFile(uploadedFile);
    console.error("❌ /api/membership :", err.message);
    res.status(500).json({ success: false, message: "Erreur serveur." });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// ROUTES ADMIN — Lecture/écriture contenu + upload images
// ═══════════════════════════════════════════════════════════════════════════════
const CONTENT_FILE = path.join(__dirname, "content.json");

app.get("/api/admin/content", requireAdmin, (req, res) => {
  try {
    res.json(fs.existsSync(CONTENT_FILE) ? JSON.parse(fs.readFileSync(CONTENT_FILE, "utf8")) : {});
  } catch { res.status(500).json({ success: false, message: "Erreur lecture." }); }
});

app.post("/api/admin/content", requireAdmin, (req, res) => {
  try {
    const current = fs.existsSync(CONTENT_FILE) ? JSON.parse(fs.readFileSync(CONTENT_FILE, "utf8")) : {};
    fs.writeFileSync(CONTENT_FILE, JSON.stringify({ ...current, ...req.body, updatedAt: new Date().toISOString() }, null, 2));
    res.json({ success: true, message: "Contenu sauvegardé." });
  } catch { res.status(500).json({ success: false, message: "Erreur sauvegarde." }); }
});

const adminImgUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => { const d = path.join(__dirname, "public", "images"); if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); cb(null, d); },
    filename: (req, file, cb) => cb(null, `img_${Date.now()}${path.extname(file.originalname).toLowerCase()}`),
  }),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => { if (["image/jpeg","image/png","image/webp"].includes(file.mimetype)) return cb(null, true); cb(new Error("Image uniquement")); },
});

app.post("/api/admin/upload", requireAdmin, adminImgUpload.single("image"), (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, message: "Pas de fichier." });
  res.json({ success: true, filename: req.file.filename, path: `/images/${req.file.filename}` });
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => console.log(`✅ Serveur ONG [${IS_PROD?"PROD":"DEV"}] → http://localhost:${PORT}`));
