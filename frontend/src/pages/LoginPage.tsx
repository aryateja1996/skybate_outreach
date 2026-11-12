import { zodResolver } from '@hookform/resolvers/zod';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { errorMessage } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { Button, Field, inputClass } from '../components/ui';

const schema = z.object({
  email: z.string().trim().email('Enter a valid email.'),
  password: z.string().min(1, 'Enter the password.'),
});

type FormValues = z.infer<typeof schema>;

export function LoginPage() {
  const { login, ready } = useAuth();
  const [formError, setFormError] = useState('');
  const form = useForm<FormValues>({ resolver: zodResolver(schema), defaultValues: { email: '', password: '' } });

  return (
    <div className="grid min-h-screen lg:grid-cols-[1.1fr_0.9fr]">
      <section className="hidden bg-rail px-12 py-16 text-paper lg:block">
        <p className="text-xs uppercase tracking-[0.2em] text-[#d7c4a8]">Skybate Technologies Pvt. Ltd.</p>
        <h1 className="mt-6 max-w-md font-serif text-5xl leading-tight">Vendor empanelment, reviewed before anything is sent.</h1>
        <p className="mt-6 max-w-md text-[#d9d3c7]">Import contacts, preview each message, and keep real sending off until SES is intentionally enabled.</p>
      </section>
      <section className="flex items-center px-6 py-16">
        <form
          className="mx-auto w-full max-w-md space-y-4"
          onSubmit={form.handleSubmit(async (values) => {
            setFormError('');
            try {
              await login(values.email, values.password);
            } catch (error) {
              setFormError(errorMessage(error));
            }
          })}
        >
          <h2 className="font-serif text-4xl">Sign in</h2>
          <Field label="Email" error={form.formState.errors.email?.message}>
            <input className={inputClass} type="email" autoComplete="username" {...form.register('email')} />
          </Field>
          <Field label="Password" error={form.formState.errors.password?.message}>
            <input className={inputClass} type="password" autoComplete="current-password" {...form.register('password')} />
          </Field>
          {formError ? <p className="text-sm text-bad">{formError}</p> : null}
          <Button type="submit" disabled={form.formState.isSubmitting || !ready}>
            {form.formState.isSubmitting ? 'Signing in…' : 'Enter the desk'}
          </Button>
        </form>
      </section>
    </div>
  );
}
