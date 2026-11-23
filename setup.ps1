<#
.SYNOPSIS
  Installe sur ce poste Windows de quoi faire parler Claude Code avec l'Odoo de l'entreprise.

.DESCRIPTION
  1. Vérifie Node.js (18 ou plus) et Claude Code.
  2. Copie le connecteur dans %USERPROFILE%\.claude-odoo\connecteur.
  3. Copie le skill dans %USERPROFILE%\.claude\skills (une version modifiée sur le poste est
     sauvegardée dans %USERPROFILE%\.claude\skills-sauvegardes avant remplacement).
  4. Crée la configuration du poste %USERPROFILE%\.config\claude-odoo\config.json si elle
     n'existe pas. Elle n'est jamais écrasée. La clé API n'est jamais passée en paramètre :
     elle est demandée en saisie masquée, ou saisie par l'utilisateur dans le fichier.
  5. Inscrit le serveur MCP « odoo » dans Claude Code (portée utilisateur, .claude.json).
  6. Pose les permissions : lecture sans question, modification toujours demandée, fichier
     de configuration illisible par Claude.
  7. Teste la connexion à Odoo.
  Relançable : ne refait que ce qui manque.
  Un fichier entreprise.json à côté de ce script (adresse, base, et au besoin modifications,
  modeles_modifiables) préremplit la configuration : rien à redemander sur chaque poste.

.PARAMETER Verifier
  Diagnostic seul : ne modifie rien.
.PARAMETER Oui
  Ne pose aucune question (installation pilotée par Claude ou par un script).
.PARAMETER Adresse
  Adresse de l'Odoo, par exemple https://monentreprise.odoo.com (nouvelle configuration).
.PARAMETER Base
  Nom de la base Odoo (nouvelle configuration).
.PARAMETER Identifiant
  Identifiant Odoo de l'utilisateur du poste (nouvelle configuration).
.PARAMETER SaisirCle
  Ouvre le profil Odoo dans le navigateur et une fenêtre de saisie masquée de la clé API,
  l'enregistre dans la configuration du poste, puis teste la connexion. C'est la voie à
  utiliser quand Claude pilote l'installation : il ne voit jamais la clé.
.PARAMETER LectureSeule
  Nouvelle configuration sans droit de modification.
.PARAMETER SansMcp
  Ne pas toucher à l'enregistrement MCP ni aux permissions de Claude Code.
.PARAMETER Racine
  Essai à blanc : tout est installé sous ce dossier au lieu du profil, sans MCP.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File setup.ps1 -Verifier
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File setup.ps1
#>
[CmdletBinding()]
param(
    [switch]$Verifier,
    [switch]$Oui,
    [string]$Adresse,
    [string]$Base,
    [string]$Identifiant,
    [switch]$SaisirCle,
    [switch]$LectureSeule,
    [switch]$SansMcp,
    [string]$Racine
)

$ErrorActionPreference = 'Stop'
$Utf8SansBom = New-Object System.Text.UTF8Encoding($false)
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

if ($PSBoundParameters.ContainsKey('Racine') -and -not $Racine.Trim()) {
    Write-Host "-Racine est vide : arrêt, pour ne pas installer pour de vrai par erreur." -ForegroundColor Red
    exit 1
}
$Source = $PSScriptRoot
$Accueil = $env:USERPROFILE
if ($Racine) {
    $Accueil = [System.IO.Path]::GetFullPath($Racine)
    $SansMcp = $true
    Write-Host "Essai à blanc : destinations sous $Accueil, pas de MCP." -ForegroundColor Yellow
}
$DestConnecteur = Join-Path $Accueil '.claude-odoo\connecteur'
$DestSkills = Join-Path $Accueil '.claude\skills'
$Sauvegardes = Join-Path $Accueil '.claude\skills-sauvegardes'
$ConfigPath = Join-Path $Accueil '.config\claude-odoo\config.json'
$Reglages = Join-Path $Accueil '.claude\settings.json'
$Index = Join-Path $DestConnecteur 'server\index.js'
$NomSkill = 'odoo-production-qualite'
$script:AFaire = 0
$script:Erreurs = 0

# Valeurs communes à tous les postes de l'entreprise, si le fichier est fourni.
$Entreprise = $null
$fEntreprise = Join-Path $Source 'entreprise.json'
if (Test-Path $fEntreprise) {
    try { $Entreprise = Get-Content -Raw -Encoding UTF8 $fEntreprise | ConvertFrom-Json }
    catch { Write-Host "entreprise.json illisible (JSON invalide) : ignoré." -ForegroundColor Yellow }
}
if ($Entreprise) {
    if (-not $Adresse -and $Entreprise.adresse) { $Adresse = $Entreprise.adresse }
    if (-not $Base -and $Entreprise.base) { $Base = $Entreprise.base }
}

function Titre([string]$t) { Write-Host ""; Write-Host "== $t" -ForegroundColor Cyan }
function Note([string]$etape, [string]$etat, [string]$detail) {
    $couleur = switch ($etat) { 'ok' { 'Green' } 'à faire' { 'Yellow' } 'erreur' { 'Red' } default { 'Gray' } }
    if ($etat -eq 'à faire') { $script:AFaire++ }
    if ($etat -eq 'erreur') { $script:Erreurs++ }
    Write-Host ("  [{0}] {1} : {2}" -f $etat, $etape, $detail) -ForegroundColor $couleur
}
function Demander-OuiNon([string]$question) {
    if ($Oui) { return $true }
    $r = Read-Host "$question [O/n]"
    return ($r -eq '' -or $r -match '^[oOyY]')
}
function Demander-Texte([string]$question, [string]$defaut) {
    if ($Oui) { return $defaut }
    $r = Read-Host $(if ($defaut) { "$question [$defaut]" } else { $question })
    if ($r) { return $r.Trim() } else { return $defaut }
}
function Trouver([string]$nom) {
    $c = Get-Command $nom -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($c) { return $c.Source } else { return $null }
}
function Hash-Dossier([string]$dir) {
    if (-not (Test-Path $dir)) { return '' }
    $lignes = Get-ChildItem -Path $dir -Recurse -File | Sort-Object FullName | ForEach-Object {
        $_.FullName.Substring($dir.Length) + ':' + (Get-FileHash -Algorithm SHA256 -Path $_.FullName).Hash
    }
    return ($lignes -join '|')
}
function Copier-Dossier([string]$de, [string]$vers) {
    if (Test-Path $vers) { Remove-Item -Recurse -Force $vers }
    New-Item -ItemType Directory -Force -Path (Split-Path $vers -Parent) | Out-Null
    Copy-Item -Recurse -Force $de $vers
}
# Fenêtre de saisie masquée : la clé va du presse-papiers de l'utilisateur au fichier de
# configuration, sans passer par le terminal ni par la conversation.
function Saisir-Cle {
    if ($Racine -and $env:CLAUDE_ODOO_CLE_ESSAI) { return $env:CLAUDE_ODOO_CLE_ESSAI }   # essai à blanc seulement
    Add-Type -AssemblyName System.Windows.Forms
    $f = New-Object System.Windows.Forms.Form
    $f.Text = 'Clé API Odoo'
    $f.Width = 540; $f.Height = 250
    $f.StartPosition = 'CenterScreen'; $f.TopMost = $true
    $f.FormBorderStyle = 'FixedDialog'; $f.MaximizeBox = $false; $f.MinimizeBox = $false
    $l = New-Object System.Windows.Forms.Label
    $l.Left = 16; $l.Top = 14; $l.Width = 490; $l.Height = 90
    $l.Text = "Dans Odoo : votre nom en haut à droite > Mon profil > Sécurité du compte > Nouvelle clé API.`r`n`r`nCollez la clé ci-dessous. Elle est enregistrée sur ce poste uniquement."
    $t = New-Object System.Windows.Forms.TextBox
    $t.Left = 16; $t.Top = 110; $t.Width = 490; $t.UseSystemPasswordChar = $true
    $ok = New-Object System.Windows.Forms.Button
    $ok.Text = 'Enregistrer'; $ok.Left = 296; $ok.Top = 156; $ok.Width = 100
    $ok.DialogResult = [System.Windows.Forms.DialogResult]::OK
    $non = New-Object System.Windows.Forms.Button
    $non.Text = 'Annuler'; $non.Left = 406; $non.Top = 156; $non.Width = 100
    $non.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
    $f.AcceptButton = $ok; $f.CancelButton = $non
    $f.Controls.AddRange(@($l, $t, $ok, $non))
    $f.Add_Shown({ $f.Activate(); $t.Focus() })
    $r = $f.ShowDialog()
    $cle = $t.Text.Trim()
    $f.Dispose()
    if ($r -eq [System.Windows.Forms.DialogResult]::OK) { return $cle }
    return ''
}
# État du serveur MCP lu dans .claude.json par node : le ConvertFrom-Json de PowerShell 5.1
# échoue sur certains .claude.json, et « claude mcp list » démarrerait les serveurs.
function Mcp-Etat([switch]$Inscrire) {
    $a = @((Join-Path $Source 'outils\mcp.js'), '--fichier', (Join-Path $env:USERPROFILE '.claude.json'), '--index', $Index)
    if (-not $Inscrire) { $a += '--verifier' }
    $sortie = (& $node @a) -join ' ; '
    return @{ Code = $LASTEXITCODE; Texte = $sortie }
}

foreach ($d in @('connecteur\server\index.js', "skills\$NomSkill\SKILL.md", 'outils\reglages.js', 'outils\mcp.js')) {
    if (-not (Test-Path (Join-Path $Source $d))) {
        Write-Host "Dossier d'installation incomplet : $d manque. Reprendre le dossier d'origine en entier." -ForegroundColor Red
        exit 1
    }
}

# ------------------------------------------------------------------ 1. Prérequis
Titre 'Prérequis'
$node = Trouver 'node'
if ($node) {
    $v = (& $node --version) -replace '^v', ''
    if ([int]($v.Split('.')[0]) -ge 18) { Note 'Node.js' 'ok' "version $v" }
    else { Note 'Node.js' 'erreur' "version $v trop ancienne : installer la version LTS (winget install OpenJS.NodeJS.LTS)"; $node = $null }
} elseif ($Verifier -or $Racine) {
    Note 'Node.js' 'à faire' 'absent : winget install OpenJS.NodeJS.LTS'
} elseif ((Trouver 'winget') -and (Demander-OuiNon 'Node.js est absent. Installer la version LTS avec winget ?')) {
    & winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
    $node = Trouver 'node'
    if ($node) { Note 'Node.js' 'ok' "installé ($(& $node --version))" }
    else { Note 'Node.js' 'erreur' "installation non aboutie : installer Node.js LTS à la main puis relancer" }
} else {
    Note 'Node.js' 'erreur' 'absent : installer Node.js LTS (https://nodejs.org) puis relancer'
}
$claude = Trouver 'claude'
if ($claude) { Note 'Claude Code' 'ok' $claude }
else { Note 'Claude Code' 'info' 'commande « claude » absente du PATH (sans incidence : application de bureau)' }

# ------------------------------------------------------------------ 2. Connecteur
Titre 'Connecteur Odoo'
$srcConnecteur = Join-Path $Source 'connecteur'
if ((Hash-Dossier $srcConnecteur) -eq (Hash-Dossier $DestConnecteur)) {
    Note 'connecteur' 'ok' $DestConnecteur
} elseif ($Verifier) {
    Note 'connecteur' 'à faire' $(if (Test-Path $DestConnecteur) { "à mettre à jour dans $DestConnecteur" } else { "à installer dans $DestConnecteur" })
} else {
    Copier-Dossier $srcConnecteur $DestConnecteur
    Note 'connecteur' 'ok' "installé dans $DestConnecteur"
}

# ------------------------------------------------------------------ 3. Skill
Titre 'Skill'
$srcSkill = Join-Path $Source "skills\$NomSkill"
$dstSkill = Join-Path $DestSkills $NomSkill
$marque = Join-Path $dstSkill '.installe-par-claude-odoo'
$hSrc = Hash-Dossier $srcSkill
$hDst = ''
if (Test-Path $dstSkill) {
    $hDst = (Get-ChildItem -Path $dstSkill -Recurse -File | Where-Object { $_.Name -ne '.installe-par-claude-odoo' } | Sort-Object FullName | ForEach-Object {
        $_.FullName.Substring($dstSkill.Length) + ':' + (Get-FileHash -Algorithm SHA256 -Path $_.FullName).Hash }) -join '|'
}
if ($hSrc -eq $hDst) {
    Note $NomSkill 'ok' $dstSkill
} elseif ($Verifier) {
    Note $NomSkill 'à faire' $(if ($hDst) { 'à mettre à jour' } else { 'à installer' })
} else {
    if ($hDst) {
        $dernier = if (Test-Path $marque) { Get-Content -Raw $marque } else { '' }
        if ($dernier.Trim() -ne $hDst) {
            $sauve = Join-Path $Sauvegardes ("{0}-{1}" -f $NomSkill, (Get-Date -Format 'yyyyMMdd-HHmmss'))
            New-Item -ItemType Directory -Force -Path $Sauvegardes | Out-Null
            Copy-Item -Recurse -Force $dstSkill $sauve
            Note $NomSkill 'info' "version modifiée sur le poste sauvegardée dans $sauve"
        }
    }
    Copier-Dossier $srcSkill $dstSkill
    [System.IO.File]::WriteAllText($marque, $hSrc, $Utf8SansBom)
    Note $NomSkill 'ok' "installé dans $dstSkill"
}

# ------------------------------------------------------------------ 4. Configuration du poste
Titre 'Configuration du poste'
$cleSaisie = $false
if (Test-Path $ConfigPath) {
    # Configuration existante : seuls les champs passés en paramètre sont corrigés, la clé n'est pas touchée.
    $corriges = @()
    if (-not $Verifier) {
        try {
            $c = Get-Content -Raw -Encoding UTF8 $ConfigPath | ConvertFrom-Json
            foreach ($paire in @(@('Adresse', 'adresse', $Adresse), @('Base', 'base', $Base), @('Identifiant', 'identifiant', $Identifiant))) {
                if ($PSBoundParameters.ContainsKey($paire[0]) -and $paire[2] -and $c.($paire[1]) -ne $paire[2]) { $c.($paire[1]) = $paire[2]; $corriges += $paire[1] }
            }
            if ($corriges) { [System.IO.File]::WriteAllText($ConfigPath, ($c | ConvertTo-Json), $Utf8SansBom) }
        } catch { Note 'configuration' 'erreur' "JSON invalide : $ConfigPath" }
    }
    Note 'configuration' 'ok' $(if ($corriges) { "$ConfigPath (corrigé : $($corriges -join ', '))" } else { "$ConfigPath (conservée)" })
} elseif ($Verifier) {
    Note 'configuration' 'à faire' "à créer : $ConfigPath"
} else {
    $cfg = Get-Content -Raw -Encoding UTF8 (Join-Path $Source 'config.exemple.json') | ConvertFrom-Json
    $cfg.adresse = Demander-Texte "Adresse de l'Odoo (https://...)" $(if ($Adresse) { $Adresse } else { '' })
    $cfg.base = Demander-Texte 'Nom de la base Odoo' $(if ($Base) { $Base } else { '' })
    $cfg.identifiant = Demander-Texte "Identifiant Odoo de l'utilisateur de ce poste" $(if ($Identifiant) { $Identifiant } else { '' })
    if ($Entreprise) {
        $props = $Entreprise.PSObject.Properties.Name
        if ($props -contains 'modifications') { $cfg.modifications = [bool]$Entreprise.modifications }
        if ($props -contains 'modeles_modifiables') { $cfg.modeles_modifiables = @($Entreprise.modeles_modifiables) }
    }
    if ($LectureSeule) { $cfg.modifications = $false }
    if (-not $Oui -and -not $SaisirCle) {
        $sec = Read-Host 'Clé API Odoo de cet utilisateur (saisie masquée, Entrée pour la mettre plus tard)' -AsSecureString
        $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
        $cle = [Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
        if ($cle) { $cfg.cle_api = $cle; $cleSaisie = $true }
    }
    New-Item -ItemType Directory -Force -Path (Split-Path $ConfigPath -Parent) | Out-Null
    [System.IO.File]::WriteAllText($ConfigPath, ($cfg | ConvertTo-Json), $Utf8SansBom)
    Note 'configuration' 'ok' "créée : $ConfigPath"
}
if ($SaisirCle -and -not $Verifier) {
    if (-not (Test-Path $ConfigPath)) {
        Note 'clé API' 'erreur' "configuration absente : lancer d'abord setup.ps1 -Oui"
    } else {
        $c = Get-Content -Raw -Encoding UTF8 $ConfigPath | ConvertFrom-Json
        if ($c.adresse -and -not $Racine) {
            try { Start-Process ($c.adresse.TrimEnd('/') + '/odoo/action-base.action_res_users_my') } catch {}
        }
        Write-Host '  Une fenêtre « Clé API Odoo » attend la saisie sur ce poste...'
        $cle = Saisir-Cle
        if ($cle) {
            $c.cle_api = $cle
            [System.IO.File]::WriteAllText($ConfigPath, ($c | ConvertTo-Json), $Utf8SansBom)
            Note 'clé API' 'ok' 'enregistrée dans la configuration du poste'
        } else {
            Note 'clé API' 'info' 'saisie annulée, rien de changé'
        }
        $cle = $null
    }
}
$cfgOk = $false
if (Test-Path $ConfigPath) {
    try {
        $c = Get-Content -Raw -Encoding UTF8 $ConfigPath | ConvertFrom-Json
        $vides = @('adresse', 'base', 'identifiant', 'cle_api') | Where-Object { -not $c.$_ }
        if ($vides -contains 'cle_api' -and @($vides).Count -eq 1) { Note 'configuration' 'à faire' 'clé API manquante : setup.ps1 -SaisirCle' }
        elseif ($vides) { Note 'configuration' 'à faire' "à compléter dans $ConfigPath : $($vides -join ', ')" }
        else { $cfgOk = $true }
    } catch { Note 'configuration' 'erreur' "JSON invalide : $ConfigPath" }
}

# ------------------------------------------------------------------ 5. MCP et permissions
Titre 'Claude Code'
if ($SansMcp) {
    Note 'serveur MCP' 'info' 'non touché (-SansMcp ou -Racine)'
} elseif (-not $node) {
    Note 'serveur MCP' 'à faire' 'Node.js manquant'
} else {
    $etat = Mcp-Etat
    if ($etat.Code -eq 0) {
        Note 'serveur MCP' 'ok' "odoo -> $Index"
    } elseif ($Verifier) {
        Note 'serveur MCP' 'à faire' $etat.Texte
    } else {
        $etat = Mcp-Etat -Inscrire
        if ($etat.Code -eq 0 -and (Mcp-Etat).Code -eq 0) { Note 'serveur MCP' 'ok' "odoo -> $Index (redémarrer Claude Code pour le charger)" }
        else { Note 'serveur MCP' 'erreur' "inscription non aboutie ($($etat.Texte)). À la main : claude mcp add odoo --scope user -- node `"$Index`"" }
    }
}
if ($node -and -not ($SansMcp -and -not $Racine)) {
    $outil = Join-Path $Source 'outils\reglages.js'
    $argsR = @($outil, '--fichier', $Reglages)
    if ($Verifier) { $argsR += '--verifier' }
    $sortie = (& $node @argsR) -join ' ; '
    switch ($LASTEXITCODE) {
        0 { Note 'permissions' 'ok' "$sortie ($Reglages)" }
        2 { Note 'permissions' 'à faire' $sortie }
        default { Note 'permissions' 'erreur' $sortie }
    }
}

# ------------------------------------------------------------------ 6. Connexion à Odoo
Titre 'Connexion à Odoo'
if (-not $node) {
    Note 'connexion' 'à faire' 'Node.js manquant'
} elseif (-not (Test-Path $Index)) {
    Note 'connexion' 'à faire' 'connecteur pas encore installé'
} elseif (-not $cfgOk) {
    Note 'connexion' 'à faire' 'configuration à compléter, puis relancer setup.ps1 -Verifier'
} else {
    $env:CLAUDE_ODOO_CONFIG = $ConfigPath
    $sortie = & $node $Index --verifier
    $code = $LASTEXITCODE
    Remove-Item Env:\CLAUDE_ODOO_CONFIG
    foreach ($l in $sortie) { Write-Host "      $l" }
    if ($code -eq 0) { Note 'connexion' 'ok' 'Odoo répond avec ce compte' }
    else { Note 'connexion' 'erreur' "voir le message ci-dessus, corriger $ConfigPath" }
}

# ------------------------------------------------------------------ Bilan
Titre 'Bilan'
if ($script:Erreurs) { Write-Host "  $($script:Erreurs) erreur(s), $($script:AFaire) point(s) à faire." -ForegroundColor Red }
elseif ($script:AFaire) { Write-Host "  $($script:AFaire) point(s) à faire." -ForegroundColor Yellow }
else {
    Write-Host '  Tout est en place.' -ForegroundColor Green
    if (-not $Verifier) { Write-Host '  Redémarrer Claude Code, puis demander : « vérifie ma connexion Odoo ».' }
}
if ($script:Erreurs) { exit 1 }
exit 0
