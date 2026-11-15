# Church glossary for translators

Translators and reviewers use this table so the same church term is rendered the same way
everywhere: dictionary, design copy, capability catalog, emails, and documentation. English
(`en`) is the source and Chinese (`zh`) is filled from the existing interface copy. **The
other ten columns are empty on purpose:** the translator for each language fills in its own
column first, before translating the dictionary, and a reviewer checks it. Translations are
AI-assisted, community review welcome.

How to use it:

1. Fill your language's column. Prefer the word a congregation in that language would say
   aloud, not a literal dictionary equivalent. Note the denomination or region you assumed
   (for example Catholic versus Protestant usage for *communion*) in the Notes column.
2. Translate `src/i18n/<code>.ts`, the design copy, and the catalog copy using these terms.
3. If a term needs two words depending on context (for example *giving* as a noun versus
   the action), add a second row instead of overloading one cell.
4. Keep this file in the same pull request as the language.

Run `node scripts/i18n/check.mjs --locale <code>` for the automated gates; the glossary is
a human check and is not machine-enforced.

## Terms

| Term (en) | 中文 (zh) | es | pt-BR | fr | de | ja | ko | ms | id | vi | hi | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **Church & people** |  |  |  |  |  |  |  |  |  |  |  |  |
| pastor | 牧师 | pastor | pastor | pasteur | Pastor/Pastorin | 牧師 | 목사 | pastor | pendeta | mục sư | पास्टर |  |
| elder | 长老 | anciano | presbítero | ancien | Ältester/Älteste | 長老 | 장로 | penatua | penatua | trưởng lão | प्राचीन |  |
| deacon | 执事 | diácono | diácono | diacre | Diakon/Diakonin | 執事 | 집사 | diakon | diaken | chấp sự | डीकन |  |
| staff | 同工 | personal | equipe | équipe pastorale / collaborateurs | Mitarbeitende | スタッフ | 교역자·스태프 | kakitangan | staf pelayan | đồng công | सेवक-दल |  |
| member | 正式会友 | miembro | membro | membre | Mitglied | 教会員 | 교인 | ahli | anggota jemaat | thành viên | सदस्य |  |
| newcomer | 新朋友 | visitante nuevo | visitante | nouveau venu | Neue/Neuer | 新来者 | 새가족 | pengunjung baharu | pendatang baru | người mới | नए आगंतुक |  |
| household | 家庭 | familia | família | foyer | Haushalt | 家庭 | 가정 | isi rumah | keluarga | gia đình | परिवार |  |
| child | 孩童 | niño | criança | enfant | Kind | 子ども | 어린이 | kanak-kanak | anak | trẻ em | बच्चा |  |
| guardian | 家长 | tutor | responsável | parent ou tuteur | Erziehungsberechtigte | 保護者 | 보호자 | penjaga | orang tua/wali | phụ huynh | अभिभावक |  |
| leader | 负责人 | líder | líder | responsable | Leitung | リーダー | 리더 | pemimpin | pemimpin | người phụ trách | अगुवा |  |
| volunteer | 义工 | voluntario | voluntário | bénévole | Ehrenamtliche | ボランティア | 봉사자 | sukarelawan | relawan | tình nguyện viên | स्वयंसेवक |  |
| campus | 堂点 | sede | campus | site | Standort | キャンパス | 캠퍼스 | kampus | kampus | cơ sở | शाखा |  |
| **Ministry & groups** |  |  |  |  |  |  |  |  |  |  |  |  |
| ministry | 事工 | ministerio | ministério | ministère | Dienstbereich | ミニストリー | 사역 | pelayanan | pelayanan | mục vụ | सेवकाई |  |
| serving team | 服事团队 | equipo de servicio | equipe de serviço | équipe de service | Dienstteam | 奉仕チーム | 봉사팀 | pasukan pelayan | tim pelayanan | đội hầu việc | सेवा दल |  |
| small group | 小组 | grupo pequeño | pequeno grupo | petit groupe | Kleingruppe | 小グループ | 소그룹 | kumpulan kecil | kelompok kecil | nhóm nhỏ | छोटा समूह |  |
| fellowship | 团契 | compañerismo | comunhão | communauté fraternelle | Gemeinschaft | フェローシップ | 교제 모임 | persekutuan | persekutuan | đoàn thể | संगति |  |
| Sunday school | 主日学 | escuela dominical | escola bíblica dominical | école du dimanche | Sonntagsschule | 教会学校 | 주일학교 | Sekolah Minggu | Sekolah Minggu | Trường Chúa Nhật | संडे स्कूल |  |
| prayer wall | 祷告墙 | muro de oración | mural de oração | mur de prière | Gebetswand | 祈りの壁 | 기도 게시판 | dinding doa | dinding doa | bảng cầu nguyện | प्रार्थना दीवार |  |
| prayer request | 祷告事项 | petición de oración | pedido de oração | sujet de prière | Gebetsanliegen | 祈りの課題 | 기도 제목 | permohonan doa | pokok doa | nhu cầu cầu nguyện | प्रार्थना निवेदन |  |
| prayer sheet | 祷告单 | hoja de oración | folha de oração | feuille de prière | Gebetsblatt | 祈り会シート | 기도 자료 | lembaran doa | lembar doa | phiếu cầu nguyện | प्रार्थना पत्रक |  |
| testimony | 见证 | testimonio | testemunho | témoignage | Zeugnis | 証し | 간증 | kesaksian | kesaksian | lời chứng | गवाही |  |
| spiritual gift | 恩赐 | don espiritual | dom espiritual | don spirituel | Geistesgabe | 霊的賜物 | 은사 | karunia rohani | karunia rohani | ân tứ thuộc linh | आत्मिक वरदान |  |
| serving opportunity | 服事机会 | oportunidad de servicio | oportunidade de servir | occasion de servir | Mitarbeitsmöglichkeit | 奉仕の機会 | 봉사 기회 | peluang melayani | kesempatan melayani | cơ hội hầu việc | सेवा का अवसर |  |
| **Worship & content** |  |  |  |  |  |  |  |  |  |  |  |  |
| worship | 敬拜 | adoración | adoração | louange | Anbetung | 賛美 | 예배 | penyembahan | penyembahan | thờ phượng | आराधना |  |
| service (gathering) | 崇拜 | culto | culto | culte | Gottesdienst | 礼拝 | 예배 | kebaktian | ibadah | buổi thờ phượng | आराधना सभा |  |
| sermon | 讲道 | sermón | mensagem | prédication | Predigt | 説教 | 설교 | khutbah | khotbah | bài giảng | संदेश |  |
| series | 系列 | serie | série | série | Reihe | シリーズ | 시리즈 | siri | seri | loạt bài | शृंखला |  |
| scripture | 经文 | Escritura | Escritura | passage biblique | Bibeltext | 聖書箇所 | 성경 본문 | ayat Alkitab | Firman/ayat Alkitab | Kinh Thánh | पवित्रशास्त्र |  |
| bulletin | 周报 | boletín | boletim | bulletin | Gemeindebrief | 週報 | 주보 | buletin | warta jemaat | bản tin | साप्ताहिक बुलेटिन |  |
| announcement | 消息 | anuncio | aviso | annonce | Mitteilung | お知らせ | 공지 | pengumuman | pengumuman | thông báo | घोषणा |  |
| article | 文章 | artículo | artigo | article | Artikel | 記事 | 글 | artikel | artikel | bài viết | लेख |  |
| event | 活动 | evento | evento | événement | Veranstaltung | イベント | 행사 | acara | acara | sự kiện | कार्यक्रम |  |
| **Sacraments** |  |  |  |  |  |  |  |  |  |  |  |  |
| baptism | 洗礼 | bautismo | batismo | baptême | Taufe | 洗礼 | 세례 | pembaptisan | baptisan | báp-têm | बपतिस्मा |  |
| communion | 圣餐 | Santa Cena | Santa Ceia | sainte cène | Abendmahl | 聖餐 | 성찬 | Perjamuan Kudus | Perjamuan Kudus | Tiệc Thánh | प्रभु भोज |  |
| **Giving & finance** |  |  |  |  |  |  |  |  |  |  |  |  |
| offering | 奉献 | ofrenda | oferta | offrande | Kollekte | 献金 | 헌금 | persembahan | persembahan | dâng hiến | भेंट |  |
| giving | 奉献 | donación (acción: dar) | contribuição | don | Spende | 献金 | 헌금 | pemberian | pemberian | dâng hiến | दान |  |
| tithe | 十一奉献 | diezmo | dízimo | dîme | Zehnten | 十分の一献金 | 십일조 | persepuluhan | persepuluhan | phần mười | दशमांश |  |
| fund | 奉献项目 | fondo | fundo | fonds | Spendenzweck | 献金項目 | 헌금 항목 | dana | dana | quỹ | निधि |  |
| donor | 奉献人 | donante | contribuinte | donateur | Spender/Spenderin | 献金者 | 헌금자 | pemberi | pemberi | người dâng hiến | दानकर्ता |  |
| recurring gift | 定期奉献 | donación recurrente | contribuição recorrente | don récurrent | Dauerspende | 定期献金 | 정기 헌금 | pemberian berulang | pemberian berkala | dâng hiến định kỳ | नियमित दान |  |
| giving statement | 奉献报表 | estado de donaciones | extrato de contribuições | relevé de dons | Spendenbescheinigung | 献金明細書 | 헌금 내역서 | penyata pemberian | laporan pemberian | bản kê dâng hiến | दान विवरण |  |
| receipt | 收据 | recibo | recibo | reçu | Beleg | 領収書 | 영수증 | resit | tanda terima | biên nhận | रसीद |  |
| registration | 活动报名 | inscripción | inscrição | inscription | Anmeldung | イベント申込 | 행사 등록 | pendaftaran | pendaftaran | đăng ký | पंजीकरण |  |
| **Scheduling** |  |  |  |  |  |  |  |  |  |  |  |  |
| run sheet | 流程单 | guion | roteiro do culto | déroulé | Ablaufplan | 進行表 | 예배 순서지 | lembaran aturan acara | rundown | chương trình chi tiết | कार्यक्रम क्रम-पत्र |  |
| rehearsal | 排练 | ensayo | ensaio | répétition | Probe | リハーサル | 리허설 | latihan | latihan | tập dượt | पूर्वाभ्यास |  |
| scheduling / roster | 服事排班 | programación de servicio | escala de serviço | planning de service | Dienstplanung | 奉仕スケジュール | 봉사 일정 | jadual pelayanan | penjadwalan pelayan | lịch hầu việc | सेवा रोस्टर |  |
| availability | 可服事时间 | disponibilidad | disponibilidade | disponibilités | Verfügbarkeit | 奉仕可能日 | 가능 시간 | kesediaan | ketersediaan | thời gian có thể phục vụ | उपलब्धता |  |
| blockout date | 不能服事的日期 | fecha no disponible | data indisponível | date d'indisponibilité | Sperrtermin | 奉仕できない日 | 불가능한 날짜 | tarikh tidak boleh melayani | tanggal tidak bisa melayani | ngày không thể hầu việc | अनुपलब्ध तिथि |  |
| assignment | 服事安排 | asignación | escalação | affectation | Einteilung | 奉仕の割り当て | 봉사 배정 | tugasan | penugasan | phân công | सेवा दायित्व |  |
| **Care & follow-up** |  |  |  |  |  |  |  |  |  |  |  |  |
| check-in | 签到 | registro de entrada | check-in | enregistrement | Check-in | 受付(チェックイン) | 체크인 | daftar masuk | check-in | điểm danh | चेक-इन |  |
| kiosk | 签到台 | quiosco | totem de check-in | borne | Kiosk | 受付端末 | 체크인 키오스크 | kiosk | kios check-in | máy điểm danh | चेक-इन कियोस्क |  |
| pickup code | 接送码 | código de recogida | código de retirada | code de récupération | Abholcode | お迎えコード | 픽업 코드 | kod pengambilan | kode penjemputan | mã đón | लेने का कोड |  |
| attendance | 出席 | asistencia | presença | présence | Anwesenheit | 出席 | 출석 | kehadiran | kehadiran | sự tham dự | उपस्थिति |  |
| follow-up | 跟进 | seguimiento | acompanhamento | suivi | Nachfassen | フォローアップ | 후속 돌봄 | susulan | tindak lanjut | theo dõi | फॉलो-अप |  |
| care | 关怀 | cuidado pastoral | cuidado | accompagnement | Seelsorge | ケア | 돌봄 | penjagaan pastoral | penggembalaan | chăm sóc | देखभाल |  |
| connection card | 新人联系卡 | tarjeta de conexión | cartão de visitante | fiche de contact | Kontaktkarte | コネクションカード | 새가족 카드 | kad perkenalan | kartu perkenalan | thẻ kết nối | संपर्क कार्ड |  |
| membership | 会籍 | membresía | membresia | adhésion | Mitgliedschaft | 教会員資格 | 교인 등록 | keahlian | keanggotaan | tư cách thành viên | सदस्यता |  |
| **Product & account** |  |  |  |  |  |  |  |  |  |  |  |  |
| sign-in link | 登录链接 | enlace de acceso | link de acesso | lien de connexion | Anmelde-Link | ログインリンク | 로그인 링크 | pautan log masuk | tautan masuk | liên kết đăng nhập | साइन-इन लिंक |  |
| administrator | 管理员 | administrador | administrador | administrateur | Administrator | 管理者 | 관리자 | pentadbir | administrator | quản trị viên | प्रशासक |  |
| editor | 编辑 | editor | editor | éditeur | Redakteur | 編集者 | 편집자 | editor | editor | biên tập viên | संपादक |  |
| language | 语言 | idioma | idioma | langue | Sprache | 言語 | 언어 | bahasa | bahasa | ngôn ngữ | भाषा |  |
| theme | 主题 | tema | tema | thème | Design | テーマ | 테마 | tema | tema | giao diện | थीम |  |
| backup | 备份 | copia de seguridad | backup | sauvegarde | Sicherung | バックアップ | 백업 | sandaran | cadangan | sao lưu | बैकअप |  |
| learning (course) | 学习 | aprendizaje | aprendizado | formation | Lernen (Kurs) | 学び | 학습 | pembelajaran | pembelajaran | học tập | शिक्षण |  |
| page builder | 页面编辑器 | editor de páginas | editor de páginas | éditeur de pages | Seiteneditor | ページビルダー | 페이지 빌더 | pembina halaman | pembuat halaman | trình tạo trang | पेज बिल्डर |  |

## Do not translate

Leave these exactly as written, in every language:

- **Product and brand names:** Church4Christ, Stripe, Cloudflare, Supabase, Google Classroom,
  Canvas, Planning Center.
- **Technical names and formats:** CSV, PDF, iCal, QR, URL, OK, API, D1, R2, Workers.
- **Placeholders:** `{name}`, `{count}`, and every other `{word}` token. Do not translate,
  rename, add, or drop them. They may move within the sentence.
- **HTML tags and entities** inside a value, such as `<b>…</b>`, `<a>…</a>`, `<br>`, `&amp;`.
  Keep the same tags; translate only the text between them.
- **URLs, email addresses, file names, route paths, and keyboard keys.**
- **Dictionary keys** (the left-hand side of `src/i18n/<code>.ts`) and any identifier in code.

Text that is legitimately identical to English in your language (a cognate such as "Contact")
goes in `config/i18n-allowlist.json` under `locales.<code>`, never as an untranslated copy.

## Translator notes

- **es**: Neutral Latin-American Spanish, informal tú for members/visitors, Protestant/evangelical usage (culto, Santa Cena, diezmo, ofrenda, anciano, diácono). Admin labels concise, infinitive/noun style for buttons. 'Giving' as nav action is 'Dar', as noun 'donación'.
- **pt**: Português do Brasil, registro 'você', vocabulário evangélico/protestante (Santa Ceia, oferta, dízimo, culto, mensagem para sermon, pequeno grupo, escola bíblica dominical).
- **fr**: Protestant/evangelical usage assumed (France/Francophone). Register: vous. Plain spaces before : ; ? !. Quotes written as guillemets.
- **de**: Register: durchgehend informelles 'du' (Freikirchen-Stil), auch in Admin-Oberflächen; Freikirche/evangelisch assumed (Gemeinde, Gottesdienst, Kleingruppe/Hauskreis, Abendmahl, Kollekte/Spende). Gendered roles use Schrägstrich forms sparingly; neutral Mitarbeitende/Ehrenamtliche preferred.
- **ja**: Assumed Japanese Protestant usage (礼拝, 牧師, 長老, 執事, 洗礼, 聖餐). Polite です/ます for sentences, noun phrases for buttons and labels. 'worship' as music is 賛美, 'service' is 礼拝. 'check-in' is チェックイン in buttons. Fellowship uses the katakana 'フェローシップ' (fellowship groups) rather than Chinese 团契.
- **ko**: Assumed Korean Protestant (장로교/개신교) usage. Register: 해요체 for member/visitor-facing sentences, concise noun phrases (명사형) for buttons/labels/headings, 합니다체 only for formal notices. 소그룹 is the default for small group (구역/셀 are denominational alternatives). 'giving' as a noun and 'offering' both render 헌금. 'Give' as a nav verb is 헌금하기. 'communion' = 성찬. Church staff roles keep 목사/장로/집사. Product names, placeholders, HTML kept as in English.
- **ms**: Register 'anda'. Protestant/evangelical Malaysian usage (kebaktian, pastor, penatua/diakon, Perjamuan Kudus, persepuluhan); Alkitab/Allah/Tuhan used in Bahasa Malaysia church style. Prefers 'log masuk', 'muat turun', 'sandaran' and Malaysian spellings (e.g. 'e-mel', 'perisian'); deliberately distinct from Indonesian (jemaat, gembala, ibadah, kantor).
- **id**: Protestant Indonesian usage (GKI/GBI/GPdI style), 'Anda' register. Communion = Perjamuan Kudus; offering = persembahan (action 'give' = memberi); small group = kelompok kecil (komsel in casual context); bulletin = warta jemaat; fellowship = persekutuan; church = gereja; Sunday = Minggu. Distinct from Malay (ms): jemaat, ibadah, pelayanan, pendeta, penatua. Membership statuses: visitor=Pengunjung, regular attender=Simpatisan, member=Anggota. 'People' admin module = Jemaat. Chinese language name rendered 'Mandarin'.
- **vi**: Protestant (Tin Lành) usage assumed. Informal 'bạn' for member/visitor copy; 'hầu việc' for serving; 'Hội Thánh' for the church body, 'nhà thờ' for the building; 'dâng hiến' for both giving and offering.
- **hi**: Protestant (Indian) usage assumed, Hindi-speaking churches; respectful आप register. Kept common loanwords: चेक-इन, फॉलो-अप, बैकअप, थीम, कियोस्क, पेज बिल्डर, ईमेल. 'assignment' in learning context = असाइनमेंट; in serving context = सेवा दायित्व. Offering/giving: भेंट (worship offering) and दान (giving).
