-- ============================================================================
-- Fills in name/role/department for the 15 test staff accounts, assuming
-- you've already created each one in Authentication -> Users with email +
-- password only (e.g. kiran@test.com). Run this once, after all 15 exist.
--
-- All set to role 'staff', department 'Ward'. Employee codes are just
-- sequential placeholders (T01, T02, ...) -- change them if you'd rather
-- use something else.
--
-- NOT marked is_test -- these need to show up in Daily Attendance/Payroll/
-- Monthly Overview for you to actually verify the numbers. Delete them
-- once you're done testing, before real staff start signing up.
-- ============================================================================

with test_staff (email, full_name, employee_code, department) as (
  values
    ('kiran@test.com',      'Kiran',      'T01', 'Ward'),
    ('jatinder@test.com',   'Jatinder',   'T02', 'Ward'),
    ('rajeev@test.com',     'Rajeev',     'T03', 'Ward'),
    ('simar@test.com',      'Simar',      'T04', 'Ward'),
    ('satwinder@test.com',  'Satwinder',  'T05', 'Ward'),
    ('prabhjot@test.com',   'Prabhjot',   'T06', 'Ward'),
    ('anjali@test.com',     'Anjali',     'T07', 'Ward'),
    ('rashmit@test.com',    'Rashmit',    'T08', 'Ward'),
    ('ramanjot@test.com',   'Ramanjot',   'T09', 'Ward'),
    ('lovepreet@test.com',  'Lovepreet',  'T10', 'Ward'),
    ('taran@test.com',      'Taran',      'T11', 'Ward'),
    ('rajveer@test.com',    'Rajveer',    'T12', 'Ward'),
    ('lucky@test.com',      'Lucky',      'T13', 'Ward'),
    ('parveen@test.com',    'Parveen',    'T14', 'Ward'),
    ('helper3@test.com',    'Helper3',    'T15', 'Ward')
)
update profiles p
set full_name = t.full_name,
    role = 'staff',
    employee_code = t.employee_code,
    department = t.department,
    is_active = true
from test_staff t
join auth.users u on u.email = t.email
where p.id = u.id;

-- Sanity check: run this after to confirm all 15 updated (should return 15 rows,
-- none with a null full_name/role).
select p.full_name, p.employee_code, p.department, p.role, u.email
from profiles p join auth.users u on u.id = p.id
where u.email like '%@test.com'
order by p.employee_code;
