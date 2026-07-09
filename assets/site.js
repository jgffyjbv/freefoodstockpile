/* Free Food Stockpile */
(function () {
  // year
  document.querySelectorAll('#yr').forEach(function (e) { e.textContent = new Date().getFullYear(); });

  // mobile nav
  var mb = document.getElementById('menuBtn');
  if (mb) mb.addEventListener('click', function () {
    var n = document.querySelector('.nav');
    if (!n) return;
    var open = n.style.display === 'flex';
    n.style.display = open ? '' : 'flex';
    if (!open) {
      n.style.cssText = 'display:flex;position:absolute;top:76px;right:20px;flex-direction:column;background:#fff;padding:16px 20px;border-radius:16px;box-shadow:var(--shadow-lg);gap:14px;z-index:70';
    }
  });

  var form = document.getElementById('applyForm');
  if (!form) return;

  var steps = form.querySelectorAll('.fstep');
  var progress = document.getElementById('progress');

  function showStep(n) {
    steps.forEach(function (s) { s.classList.toggle('hide', s.getAttribute('data-step') !== String(n)); });
    progress.querySelectorAll('.p').forEach(function (p) {
      var d = +p.getAttribute('data-step');
      p.classList.toggle('active', d === n);
      p.classList.toggle('done', d < n);
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function validate(stepEl) {
    var ok = true, first = null;
    stepEl.querySelectorAll('[required]').forEach(function (inp) {
      var bad = (inp.type === 'checkbox') ? !inp.checked : !String(inp.value).trim();
      inp.style.borderColor = bad ? '#e0523a' : '';
      if (bad && !first) first = inp;
      if (bad) ok = false;
    });
    if (first) { first.focus(); first.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
    return ok;
  }

  // ---- household members ----
  var hhList = document.getElementById('hhList');
  var hhCount = 0;
  document.getElementById('addHh').addEventListener('click', function () {
    hhCount++;
    var d = document.createElement('div');
    d.className = 'hh-member';
    d.innerHTML =
      '<button type="button" class="rm">Remove ✕</button>' +
      '<div class="grid2">' +
        '<div class="field"><label>Full name <span class="req">*</span></label><input class="hh-name" placeholder="Name"></div>' +
        '<div class="field"><label>Date of birth</label><input type="date" class="hh-dob"><div class="hint">Optional — but including it helps us process your application faster.</div></div>' +
        '<div class="field full"><label>Relationship</label><input class="hh-rel" placeholder="e.g. spouse, child, parent"></div>' +
      '</div>';
    d.querySelector('.rm').addEventListener('click', function () { d.remove(); });
    hhList.appendChild(d);
    d.querySelector('.hh-name').focus();
  });

  function validateHousehold() {
    var ok = true;
    hhList.querySelectorAll('.hh-member').forEach(function (m) {
      var name = m.querySelector('.hh-name');
      var hasAny = name.value.trim() || m.querySelector('.hh-dob').value.trim() || m.querySelector('.hh-rel').value.trim();
      var bad = hasAny && !name.value.trim();
      name.style.borderColor = bad ? '#e0523a' : '';
      if (bad) { ok = false; name.focus(); }
    });
    return ok;
  }

  function compileHousehold() {
    var out = [];
    hhList.querySelectorAll('.hh-member').forEach(function (m, i) {
      var name = m.querySelector('.hh-name').value.trim();
      var dob = m.querySelector('.hh-dob').value.trim();
      var rel = m.querySelector('.hh-rel').value.trim();
      if (name || dob || rel) out.push((i + 1) + ') ' + [name, dob, rel].filter(Boolean).join(' — '));
    });
    return out.length ? out.join('\n') : 'None listed';
  }

  // ---- nav buttons ----
  document.getElementById('toStep2').addEventListener('click', function () {
    var s1 = form.querySelector('.fstep[data-step="1"]');
    if (validate(s1) && validateHousehold()) showStep(2);
  });
  document.getElementById('backStep1').addEventListener('click', function () { showStep(1); });

  // ---- Medicaid card upload: 10MB client-side check ----
  var fileInput = document.getElementById('medicaidCard');
  var fileError = document.getElementById('fileError');
  if (fileInput) fileInput.addEventListener('change', function () {
    var tooBig = fileInput.files[0] && fileInput.files[0].size > 10 * 1024 * 1024;
    fileError.style.display = tooBig ? 'block' : 'none';
    if (tooBig) fileInput.value = '';
  });

  // ---- submit ----
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var step2 = form.querySelector('.fstep[data-step="2"]');
    if (!validate(step2)) return;

    var btn = document.getElementById('submitBtn');
    btn.disabled = true; btn.textContent = 'Submitting…';

    // multipart FormData so the optional Medicaid-card file rides along
    var fd = new FormData();
    form.querySelectorAll('input[name], select[name], textarea[name]').forEach(function (f) {
      if (f.type === 'file') { if (f.files[0]) fd.append(f.name, f.files[0]); }
      else if (f.type === 'checkbox') { fd.append(f.name, f.checked ? f.value : 'No'); }
      else fd.append(f.name, f.value);
    });
    fd.append('Household Members', compileHousehold());

    var email = window.FFS_FORM_EMAIL || 'millerkjhs@gmail.com';
    fetch('https://formsubmit.co/ajax/' + encodeURIComponent(email), {
      method: 'POST',
      headers: { 'Accept': 'application/json' },
      body: fd
    }).then(function (r) { return r.json(); })
      .then(function (res) {
        if (res && (res.success === true || res.success === 'true')) { showStep(3); return; }
        throw new Error('send failed');
      })
      .catch(function () {
        btn.disabled = false; btn.textContent = 'Submit application ✓';
        alert('We could not send your application just now. Please try again in a moment — or call or text us at (845) 540-5512 and we will take your application by phone.');
      });
  });
})();
