-- users and profiles (as service / superuser, like the admin-users function would)
insert into auth.users values
 ('11111111-1111-1111-1111-111111111111','nino@kursi.ge'),
 ('22222222-2222-2222-2222-222222222222','n.philauri@kursi.ge'),
 ('33333333-3333-3333-3333-333333333333','t.khosroshvili@kursi.ge'),
 ('44444444-4444-4444-4444-444444444444','rati@kursi.ge');
insert into public.profiles (auth_user_id,email,full_name,role) values
 ('11111111-1111-1111-1111-111111111111','nino@kursi.ge','Nino Kuprashvili','admin'),
 ('22222222-2222-2222-2222-222222222222','n.philauri@kursi.ge','Natali Philauri','kam'),
 ('33333333-3333-3333-3333-333333333333','t.khosroshvili@kursi.ge','Tatia Khosroshvili','kam'),
 ('44444444-4444-4444-4444-444444444444','rati@kursi.ge','Rati Maghlakelidze','manager');
